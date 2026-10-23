param([Parameter(Mandatory=$true)][ValidateSet('confirm','tray','autostart','setup')][string]$Action)
$ErrorActionPreference = 'Stop'
try {
    # detached PowerShell has no console; assigning these throws. Redirected stdin still works.
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {}
$InputData = [Console]::In.ReadToEnd() | ConvertFrom-Json

if($Action -eq 'setup'){
    foreach($Value in @($InputData.codex,$InputData.home)){if($Value -notmatch '^[A-Za-z]:\\' -or $Value -match '["\r\n]'){throw 'Unsupported setup path'}}
    $Sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $Setup=Join-Path $PSScriptRoot 'elevated-setup.ps1'
    $Arguments='-NoLogo -NoProfile -File "'+$Setup+'" -Codex "'+$InputData.codex+'" -CodexHome "'+$InputData.home+'" -ExpectedSid "'+$Sid+'"'
    $Process=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $Arguments -Verb RunAs -Wait -PassThru
    if($Process.ExitCode -ne 0){throw 'Optional elevated setup failed or was cancelled'}
    @{setup='completed'; next='real sandbox capability probe'} | ConvertTo-Json -Compress
    exit 0
}

if ($Action -eq 'autostart') {
    if ($InputData.instance -notmatch '^[a-f0-9]{24}$') { throw 'Invalid instance' }
    $Name = 'SunMoonLink-' + $InputData.instance
    $Marker = 'SunMoon link current-user login v1 ' + $InputData.instance
    $Wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    foreach ($Value in @($InputData.node,$InputData.cli,$InputData.state,$InputData.hiddenScript)) {
        if ($Value -notmatch '^[A-Za-z]:\\' -or $Value -match '["\r\n]') { throw 'Unsupported task path' }
    }
    $Arguments = '//B //Nologo "' + $InputData.hiddenScript + '" "' + $InputData.node + '" "' + $InputData.cli + '" "' + $InputData.state + '"'
    $Existing = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if ($Existing -and ($Existing.Description -ne $Marker -or $Existing.Actions.Count -ne 1 -or $Existing.Actions[0].Execute -ne $Wscript -or $Existing.Actions[0].Arguments -ne $Arguments)) {
        throw 'Task name belongs to another configuration; refusing to modify it'
    }
    if ($InputData.action -eq 'enable') {
        $User = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $TaskAction = New-ScheduledTaskAction -Execute $Wscript -Argument $Arguments
        $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
        $Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
        $Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
        Register-ScheduledTask -TaskName $Name -Description $Marker -Action $TaskAction -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
    } elseif ($InputData.action -eq 'disable') {
        if ($Existing) { Unregister-ScheduledTask -TaskName $Name -Confirm:$false }
    } elseif ($InputData.action -ne 'status') { throw 'Unsupported action' }
    $Task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    @{name=$Name; installed=[bool]$Task; enabled=([bool]$Task -and $Task.Settings.Enabled); runLevel=if($Task){[string]$Task.Principal.RunLevel}else{$null}} | ConvertTo-Json -Compress
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
namespace SunMoonDesktop {
    public static class WindowVisibility {
        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr handle, int command);
        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr handle);
    }
}
'@
[System.Windows.Forms.Application]::EnableVisualStyles()

function New-FormWatchdog([System.Windows.Forms.Form]$Window) {
    # Create the handle before starting: a new (not yet shown) form is not lost.
    $null = $Window.Handle
    $Watch = New-Object System.Windows.Forms.Timer; $Watch.Interval=1000
    $Watch.Add_Tick({
        if ($Window.IsDisposed -or -not $Window.IsHandleCreated) {
            [System.Windows.Forms.Application]::Exit()
        }
    }.GetNewClosure())
    return $Watch
}

function Initialize-VisibleForm([System.Windows.Forms.Form]$Window) {
    $Window.Add_Shown({
        param($Sender,$Event)
        [void][SunMoonDesktop.WindowVisibility]::ShowWindow($Sender.Handle,5)
        $Sender.Activate()
        if (-not [SunMoonDesktop.WindowVisibility]::IsWindowVisible($Sender.Handle)) { $Sender.Close() }
    })
}

if ($Action -eq 'confirm') {
    if ($InputData.challenge -notmatch '^[a-f0-9]{32}$' -or $InputData.description.Length -gt 16000) { throw 'Invalid prompt' }
    $Form = New-Object System.Windows.Forms.Form
    $Form.Text = 'SunMoon - 本机权限确认'
    $Form.Size = New-Object System.Drawing.Size(730,590)
    $Form.StartPosition = 'CenterScreen'; $Form.TopMost = $true; $Form.MinimizeBox = $false; $Form.MaximizeBox = $false
    $Description = New-Object System.Windows.Forms.TextBox
    $Description.Multiline=$true; $Description.ReadOnly=$true; $Description.ScrollBars='Vertical'
    $Description.SetBounds(15,15,680,365); $Description.Text=[string]$InputData.description
    $Label = New-Object System.Windows.Forms.Label
    $Label.SetBounds(15,395,680,48)
    $Code = $InputData.challenge.Substring(0,6)
    $Label.Text = '核对以上范围。若同意，请输入本机确认码 ' + $Code + '，再点击允许。关闭或超时均拒绝。'
    $Answer = New-Object System.Windows.Forms.TextBox; $Answer.SetBounds(15,449,220,28)
    $Allow = New-Object System.Windows.Forms.Button; $Allow.Text='允许本次会话'; $Allow.SetBounds(340,495,165,32); $Allow.Enabled=$false
    $Deny = New-Object System.Windows.Forms.Button; $Deny.Text='拒绝'; $Deny.SetBounds(530,495,165,32)
    $Form.Tag=$false; $Form.CancelButton=$Deny
    $Answer.Add_TextChanged({ $Allow.Enabled = ($Answer.Text -ceq $Code) })
    $Allow.Add_Click({ if ($Answer.Text -ceq $Code) { $Form.Tag=$true; $Form.Close() } })
    $Deny.Add_Click({ $Form.Close() })
    $Timer = New-Object System.Windows.Forms.Timer; $Timer.Interval=60000
    $Timer.Add_Tick({ $Timer.Stop(); $Form.Close() })
    $Form.Controls.AddRange(@($Description,$Label,$Answer,$Allow,$Deny))
    Initialize-VisibleForm $Form
    $Watch = New-FormWatchdog $Form
    try { $Watch.Start(); $Timer.Start(); $Form.ShowDialog() | Out-Null; $Approved = [bool]$Form.Tag }
    finally { $Watch.Stop(); $Watch.Dispose(); $Timer.Stop(); $Timer.Dispose(); $Form.Dispose(); [System.Windows.Forms.Application]::Exit() }
    @{approved=$Approved; challenge=if($Approved){$InputData.challenge}else{$null}} | ConvertTo-Json -Compress
    exit 0
}

# The tray is a separate process. Closing it never stops the background agent.
$Node = [string]$InputData.node; $Cli = [string]$InputData.cli; $State = [string]$InputData.state
if ($Node -match '["\r\n]' -or $Cli -match '["\r\n]') { throw 'Unsupported executable path' }

function New-AgentProcess([string[]]$Command, [bool]$Detached=$false) {
    # Command strings are fixed menu verbs. User values are only JSON on stdin.
    if (@($Command | Where-Object { $_ -notmatch '^[a-z-]+$' }).Count) { throw 'Invalid menu action' }
    $Exec = @(); $ExtraCa = $null
    $NodeDir = Split-Path -Parent $Node
    if ((Split-Path -Leaf $NodeDir) -eq 'node') {
        $Root = Split-Path -Parent $NodeDir
        $SiteFile = Join-Path $Root 'site\site.json'
        if (Test-Path -LiteralPath $SiteFile) {
            $Exec = @('--use-system-ca')
            $Raw = Get-Content -LiteralPath $SiteFile -Raw -Encoding UTF8
            $Ca = Join-Path $Root 'site\ca.pem'
            if ($Raw.Contains('"mode": "bundled-ca"') -and (Test-Path -LiteralPath $Ca)) { $ExtraCa = $Ca }
        }
    }
    $Info = New-Object System.Diagnostics.ProcessStartInfo
    $Info.FileName=$Node
    $Prefix = if ($Exec.Count) { ($Exec -join ' ') + ' ' } else { '' }
    $Info.Arguments=$Prefix + '"' + $Cli + '" ' + ($Command -join ' ')
    $Info.UseShellExecute=$false; $Info.CreateNoWindow=$true
    $Info.RedirectStandardInput=$true; $Info.RedirectStandardOutput=$true; $Info.RedirectStandardError=$true
    $Info.StandardOutputEncoding=New-Object System.Text.UTF8Encoding($false)
    $Info.EnvironmentVariables['SUNMOON_AGENT_HOME']=$State
    if ($Exec.Count) {
        if ($Info.EnvironmentVariables.ContainsKey('NODE_OPTIONS')) { [void]$Info.EnvironmentVariables.Remove('NODE_OPTIONS') }
        if ($Info.EnvironmentVariables.ContainsKey('NODE_EXTRA_CA_CERTS')) { [void]$Info.EnvironmentVariables.Remove('NODE_EXTRA_CA_CERTS') }
        if ($ExtraCa) { $Info.EnvironmentVariables['NODE_EXTRA_CA_CERTS'] = $ExtraCa }
    }
    # .NET refuses StandardOutputEncoding unless stdout is redirected; a detached start must clear it (0.3.2, tray reconnect fix).
    if($Detached){$Info.RedirectStandardInput=$false; $Info.RedirectStandardOutput=$false; $Info.RedirectStandardError=$false; $Info.StandardOutputEncoding=$null}
    $Process=New-Object System.Diagnostics.Process; $Process.StartInfo=$Info
    $Process.Start() | Out-Null
    return $Process
}
function Invoke-Agent([string[]]$Command, $Body=$null, [int]$TimeoutMs=35000) {
    $Process=New-AgentProcess $Command
    if ($null -ne $Body) { $Process.StandardInput.Write(($Body | ConvertTo-Json -Depth 8 -Compress)) }
    $Process.StandardInput.Close()
    $ReadOut=$Process.StandardOutput.ReadToEndAsync(); $ReadErr=$Process.StandardError.ReadToEndAsync()
    if (-not $Process.WaitForExit($TimeoutMs)) { $Process.Dispose(); throw '操作未及时完成，请查看状态；没有强杀进程。' }
    $Text=$ReadOut.Result; $ErrorText=$ReadErr.Result; $ExitCode=$Process.ExitCode; $Process.Dispose()
    if ($ExitCode -ne 0) { throw '操作未完成，请使用 CLI 查看原因和本地日志。' }
    if ($Text.Trim()) { return ($Text | ConvertFrom-Json) }
}
# 托盘只看得到本地 link 这一端连没连着会合点；沙箱那一端和配对成功没有，在网页设置「电脑与沙箱」里看（会合点备忘第四、十节）。
function Get-ConnectionText($Current) {
    if (-not $Current) { return '本地 link 没在运行' }
    if (-not $Current.running) {
        if ($Current.relay.status -eq 'rejected') { return '本地 link 没连着：被拒绝，已退出' }
        return '本地 link 没在运行或状态过期'
    }
    switch ([string]$Current.relay.status) {
        'connected' { return '本地 link 连着' }
        'connecting' { return '本地 link 正在连接' }
        'rejected' { return '本地 link 没连着：被拒绝' }
        default { return '本地 link 没连着，等待重连' }
    }
}
# Codex 命令隔离（SDD 0041 第四节）：提权模式用独立的沙箱账户，白名单外写不进也删不掉；普通模式只拦写、不拦删。
function Get-IsolationText([string]$Mode) {
    if ($Mode -eq 'elevated') { return 'Codex 命令隔离：提权模式（独立的沙箱账户，白名单外写不进、删不掉）' }
    if ($Mode -eq 'unelevated') { return 'Codex 命令隔离：普通模式——白名单外写不进，但能删文件' }
    return 'Codex 命令隔离：暂不可读'
}
function Invoke-SandboxUpgrade([string]$Intro='') {
    $Ask=$Intro+'提高到提权模式要管理员确认一次：Windows 会弹出确认框，点「是」。期间本地 link 会停下再起来，约半分钟。'+"`r`n`r`n"+'现在提高吗？'
    if ([System.Windows.Forms.MessageBox]::Show($Ask,'SunMoon','YesNo','Question') -ne 'Yes') { return $false }
    try {
        $Result=Invoke-Agent @('sandbox-upgrade') $null 600000
        if ([string]$Result.windowsSandbox.mode -eq 'elevated') {
            [System.Windows.Forms.MessageBox]::Show('已提高：Codex 的命令改用独立的沙箱账户运行，本地 link 已重新起来。','SunMoon')|Out-Null
            return $true
        }
    } catch {}
    [System.Windows.Forms.MessageBox]::Show('没有提高成（取消了管理员确认，或这台电脑不允许）。本地 link 照旧以普通模式运行；以后可在「这台电脑上的设置」里再试。','SunMoon')|Out-Null
    return $false
}
function Show-Status {
    try {
        $Current=Invoke-Agent @('status')
        $Reason=if($Current.relay.lastError){[string]$Current.relay.lastError}elseif($Current.relay.lastNotice){[string]$Current.relay.lastNotice}elseif($Current.running){'无连接错误'}else{'本地 link 没在运行；从开始菜单打开 SunMoon link'}
        $Text='状态：'+(Get-ConnectionText $Current)+"`r`n`r`n原因："+$Reason
        if($Current.relay.lastNotice -and $Current.relay.lastNotice -ne $Reason){$Text+="`r`n提示："+[string]$Current.relay.lastNotice}
        if($Current.execServer.windowsSandbox.mode){$Text+="`r`n`r`n沙箱模式："+[string]$Current.execServer.windowsSandbox.mode}
        if($Current.at){$Text+="`r`n状态更新时间："+[string]$Current.at}
    } catch {$Text='无法读取本地 link 的状态，请查看本机日志。'}
    try {
        $Page=Invoke-Agent @('pair-page-status')
        if($Page.active){
            $Text+="`r`n`r`n本机颁发令牌页："+[string]$Page.url
            if($Page.user_code){$Text+="`r`n确认码："+[string]$Page.user_code}
            $Text+="`r`n网站页会自动填码；没打开就复制上面的地址到浏览器"
            if($Page.message){$Text+="`r`n"+[string]$Page.message}
        }
    } catch {}
    $Dialog=New-Object System.Windows.Forms.Form; $Dialog.Text='SunMoon - 状态与原因'; $Dialog.Size=New-Object System.Drawing.Size(700,400); $Dialog.StartPosition='CenterScreen'
    $StatusText=New-Object System.Windows.Forms.TextBox; $StatusText.Multiline=$true; $StatusText.ReadOnly=$true; $StatusText.ScrollBars='Vertical'; $StatusText.SetBounds(15,15,650,285); $StatusText.Text=$Text
    $Close=New-Object System.Windows.Forms.Button; $Close.Text='关闭'; $Close.SetBounds(545,310,120,30); $Close.Add_Click({$Dialog.Close()}); $Dialog.CancelButton=$Close
    $Dialog.Controls.AddRange(@($StatusText,$Close)); Initialize-VisibleForm $Dialog
    $Watch=New-FormWatchdog $Dialog
    try{$Watch.Start(); $Dialog.ShowDialog()|Out-Null}finally{$Watch.Stop(); $Watch.Dispose(); $Dialog.Dispose()}
}
function Show-Preferences {
    $Prefs=Invoke-Agent @('settings','show')
    $Dialog=New-Object System.Windows.Forms.Form; $Dialog.Text='SunMoon - 这台电脑上的设置'; $Dialog.Size=New-Object System.Drawing.Size(700,655); $Dialog.StartPosition='CenterScreen'
    $NameLabel=New-Object System.Windows.Forms.Label; $NameLabel.Text='电脑名'; $NameLabel.SetBounds(15,15,100,24)
    $Name=New-Object System.Windows.Forms.TextBox; $Name.Text=$Prefs.machineName; $Name.SetBounds(120,15,500,26)
    $RootLabel=New-Object System.Windows.Forms.Label; $RootLabel.Text='勾选允许访问的目录；未勾选的目录只记住位置，不授予访问权限。'; $RootLabel.SetBounds(15,52,650,26)
    $Roots=New-Object System.Windows.Forms.CheckedListBox; $Roots.Name='DirectoryChoices'; $Roots.AccessibleName='允许访问的目录'; $Roots.CheckOnClick=$true; $Roots.HorizontalScrollbar=$true; $Roots.SetBounds(15,82,650,170)
    $Choices=if($null -ne $Prefs.rootChoices){@($Prefs.rootChoices)}else{@($Prefs.roots)}
    foreach($Root in $Choices){$Roots.Items.Add([string]$Root,([bool](@($Prefs.roots) -contains $Root)))|Out-Null}
    $Add=New-Object System.Windows.Forms.Button; $Add.Text='添加待选目录'; $Add.SetBounds(15,265,135,30)
    $Remove=New-Object System.Windows.Forms.Button; $Remove.Text='移除选中行'; $Remove.SetBounds(165,265,135,30)
    $Add.Add_Click({ $Picker=New-Object System.Windows.Forms.FolderBrowserDialog; try { if($Picker.ShowDialog() -eq 'OK' -and -not $Roots.Items.Contains($Picker.SelectedPath)){$Roots.Items.Add($Picker.SelectedPath,$false)|Out-Null} } finally{$Picker.Dispose()} })
    $Remove.Add_Click({ if($Roots.SelectedIndex -ge 0){$Roots.Items.RemoveAt($Roots.SelectedIndex)} })
    $Mode=New-Object System.Windows.Forms.ComboBox; $Mode.DropDownStyle='DropDownList'; $Mode.SetBounds(15,310,230,28); $Mode.Items.AddRange(@('read-only','workspace-write')); $Mode.SelectedItem=$Prefs.ceiling.sandbox
    $Network=New-Object System.Windows.Forms.CheckBox; $Network.Text='允许联网（包括本机代发 MCP HTTP）'; $Network.Checked=[bool]$Prefs.ceiling.network; $Network.SetBounds(270,310,395,28)
    $LibraryLabel=New-Object System.Windows.Forms.Label; $LibraryLabel.Text='本地知识库目录'; $LibraryLabel.SetBounds(15,350,130,26)
    $Library=New-Object System.Windows.Forms.TextBox; $Library.Name='LibraryDirectory'; $Library.AccessibleName='本地知识库目录'; $Library.ReadOnly=$true; $Library.Text=[string]$Prefs.libraryDir; $Library.SetBounds(150,350,350,26)
    $PickLibrary=New-Object System.Windows.Forms.Button; $PickLibrary.Text='选目录'; $PickLibrary.SetBounds(510,350,75,28)
    $ClearLibrary=New-Object System.Windows.Forms.Button; $ClearLibrary.Text='清空'; $ClearLibrary.SetBounds(595,350,70,28)
    $PickLibrary.Add_Click({ $Picker=New-Object System.Windows.Forms.FolderBrowserDialog; try { if($Picker.ShowDialog() -eq 'OK'){$Library.Text=$Picker.SelectedPath} } finally{$Picker.Dispose()} })
    $ClearLibrary.Add_Click({$Library.Clear()})
    $LibraryNote=New-Object System.Windows.Forms.Label; $LibraryNote.Text='知识库目录仅供读取，不授予工作区写入权限。'; $LibraryNote.SetBounds(150,382,515,26)
    # 登录时自动运行：和网页设置「电脑与沙箱」里的是同一个开关（Windows 任务计划程序的登录任务）
    $AutoRun=New-Object System.Windows.Forms.CheckBox; $AutoRun.Name='RunAtLogon'; $AutoRun.Text='登录时自动运行'; $AutoRun.SetBounds(15,415,650,28)
    $AutoWas=$false
    try { $AutoWas=[bool](Invoke-Agent @('autostart','status')).enabled; $AutoRun.Checked=$AutoWas } catch { $AutoRun.Enabled=$false }
    $NoteText='保存后本地 link 会自己重启生效。全部取消勾选可关闭项目目录访问；临时批准在断开时失效。'
    $IsoMode=''
    try { $Current=Invoke-Agent @('status'); $IsoMode=[string]$Current.execServer.windowsSandbox.mode; if($Current.relay.lastError){$NoteText+="`r`n"+[string]$Current.relay.lastError} } catch {}
    $Isolation=New-Object System.Windows.Forms.Label; $Isolation.Name='SandboxIsolation'; $Isolation.Text=(Get-IsolationText $IsoMode); $Isolation.SetBounds(15,452,470,40)
    $Upgrade=New-Object System.Windows.Forms.Button; $Upgrade.Name='UpgradeSandbox'; $Upgrade.Text='提高安全（要管理员确认）'; $Upgrade.SetBounds(490,448,175,30); $Upgrade.Visible=($IsoMode -eq 'unelevated')
    $Upgrade.Add_Click({ if (Invoke-SandboxUpgrade) { $Dialog.Close() } })
    $Note=New-Object System.Windows.Forms.Label; $Note.Text=$NoteText; $Note.SetBounds(15,495,650,55)
    $Save=New-Object System.Windows.Forms.Button; $Save.Name='SaveSettings'; $Save.Text='保存设置'; $Save.SetBounds(405,560,120,30)
    $Cancel=New-Object System.Windows.Forms.Button; $Cancel.Text='取消'; $Cancel.SetBounds(545,560,120,30)
    $Save.Add_Click({
        try {
            Invoke-Agent @('settings','set') @{machineName=$Name.Text; roots=@($Roots.CheckedItems | ForEach-Object{[string]$_}); rootChoices=@($Roots.Items | ForEach-Object{[string]$_}); ceiling=@{sandbox=[string]$Mode.SelectedItem; network=[bool]$Network.Checked}; libraryDir=$(if($Library.Text){$Library.Text}else{$null})} | Out-Null
            if ($AutoRun.Enabled -and $AutoRun.Checked -ne $AutoWas) { Invoke-Agent @('autostart',$(if($AutoRun.Checked){'enable'}else{'disable'})) | Out-Null }
            # 和从网页改设置一样，保存后本地 link 自己重启，不要用户手动停再启（会合点备忘第十节）
            Invoke-Agent @('restart-resident') | Out-Null
            [System.Windows.Forms.MessageBox]::Show('已保存，本地 link 已重启生效。','SunMoon')|Out-Null; $Dialog.Close()
        } catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'SunMoon')|Out-Null }
    })
    $Cancel.Add_Click({$Dialog.Close()}); $Dialog.CancelButton=$Cancel
    $Dialog.Controls.AddRange(@($NameLabel,$Name,$RootLabel,$Roots,$Add,$Remove,$Mode,$Network,$LibraryLabel,$Library,$PickLibrary,$ClearLibrary,$LibraryNote,$AutoRun,$Isolation,$Upgrade,$Note,$Save,$Cancel))
    Initialize-VisibleForm $Dialog
    $Watch = New-FormWatchdog $Dialog
    try{$Watch.Start(); $Dialog.ShowDialog()|Out-Null}finally{$Watch.Stop(); $Watch.Dispose(); $Dialog.Dispose()}
}

try {
if ($InputData.instance -notmatch '^[a-f0-9]{24}$') { throw 'Invalid instance' }
$Mutex = New-Object System.Threading.Mutex($false,('Local\SunMoonLinkTray-' + $InputData.instance))
if (-not $Mutex.WaitOne(0,$false)) { $Mutex.Dispose(); exit 0 }

# Tray has no visible main form. Its private, unshown form owns the UI lifetime;
# closing a preferences dialog normally does not close the tray.
$TrayForm=New-Object System.Windows.Forms.Form
$Watch=New-FormWatchdog $TrayForm
$Tray=New-Object System.Windows.Forms.NotifyIcon; $Tray.Icon=[System.Drawing.SystemIcons]::Application; $Tray.Text='SunMoon link'; $Tray.Visible=$true
$Menu=New-Object System.Windows.Forms.ContextMenuStrip
$Connection=$Menu.Items.Add('状态：正在读取'); $Connection.Enabled=$false
$Status=$Menu.Items.Add('查看状态与原因'); $Status.Add_Click({ Show-Status })
$Tray.Add_DoubleClick({Show-Status})
# 五项（会合点备忘第十节）：不设启动 / 停止、暂停 / 继续；不让云端碰这台电脑靠白名单与上限，真要断开就退出 link，
# 退出后从开始菜单打开就是重启。登录时自动运行在「这台电脑上的设置」里勾。
$Preferences=$Menu.Items.Add('这台电脑上的设置'); $Preferences.Add_Click({ try{Show-Preferences}catch{[System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'SunMoon')|Out-Null} })
$Reissue=$Menu.Items.Add('重新颁发令牌'); $Reissue.Add_Click({
    try{$PageProcess=New-AgentProcess @('pair','--page') $true; $PageProcess.Dispose()}
    catch{[System.Windows.Forms.MessageBox]::Show('本机颁发令牌页未打开，请查看状态与原因。','SunMoon')|Out-Null}
})
$Menu.Items.Add('-')|Out-Null
# 对用户来说托盘和本地 link 是一个东西：退出就一起退出，不留一个看不见的本地 link 在后台
$Exit=$Menu.Items.Add('退出 link'); $Exit.Add_Click({
    try { Invoke-Agent @('stop') | Out-Null } catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'SunMoon')|Out-Null; return }
    [System.Windows.Forms.Application]::Exit()
})
$Tray.ContextMenuStrip=$Menu
$TrayId=[Guid]::NewGuid().ToString()
$TrayStatus=Join-Path $State 'tray.json'; $TrayStop=Join-Path $State 'tray-stop.json'
@{pid=$PID;runId=$TrayId} | ConvertTo-Json -Compress | Set-Content -LiteralPath $TrayStatus -Encoding UTF8
$Timer=New-Object System.Windows.Forms.Timer; $Timer.Interval=5000
$Timer.Add_Tick({
    try {
        if(Test-Path -LiteralPath $TrayStop){
            $Request=Get-Content -LiteralPath $TrayStop -Raw -Encoding UTF8 | ConvertFrom-Json
            if($Request.pid -eq $PID -and $Request.runId -eq $TrayId){
                Remove-Item -LiteralPath $TrayStop
                [System.Windows.Forms.Application]::Exit(); return
            }
        }
        $StatusPath=Join-Path $State 'status.json'
        if(Test-Path -LiteralPath $StatusPath){
            $Current=Get-Content -LiteralPath $StatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $Age=((Get-Date).ToUniversalTime()-[DateTime]::Parse($Current.at).ToUniversalTime()).TotalSeconds
            $Current|Add-Member -NotePropertyName running -NotePropertyValue ($Age -ge -2 -and $Age -lt 15) -Force
            $Label=Get-ConnectionText $Current
            $Tip='SunMoon link: '+$Label; if($Tip.Length -gt 63){$Tip=$Tip.Substring(0,63)}
            $Tray.Text=$Tip
            if($Current.relay.lastError){$Connection.Text=[string]$Current.relay.lastError}else{$Connection.Text='状态：'+$Label}
        } else {$Tray.Text='SunMoon link: 没在运行';$Connection.Text='状态：本地 link 没在运行'}
    } catch {$Tray.Text='SunMoon link: 状态暂不可读';$Connection.Text='状态：暂不可读'}
})
# 还是普通模式就问一次要不要提高：只问一次（记在控制目录的 sandbox-offer.json），以后在「这台电脑上的设置」里提高。
# 本地 link 刚起来时状态文件可能还没写，隔 8 秒再看，最多看 10 次。
$script:OfferTries=0
$Offer=New-Object System.Windows.Forms.Timer; $Offer.Interval=8000
$Offer.Add_Tick({
    try {
        $OfferFile=Join-Path $State 'sandbox-offer.json'; $StatusPath=Join-Path $State 'status.json'
        if (Test-Path -LiteralPath $OfferFile) { $Offer.Stop(); return }
        $script:OfferTries++
        if (-not (Test-Path -LiteralPath $StatusPath)) { if ($script:OfferTries -ge 10) { $Offer.Stop() }; return }
        $Current=Get-Content -LiteralPath $StatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $Mode=[string]$Current.execServer.windowsSandbox.mode
        if (-not $Mode) { if ($script:OfferTries -ge 10) { $Offer.Stop() }; return }
        $Offer.Stop()
        if ($Mode -ne 'unelevated') { return }
        @{offeredAt=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress | Set-Content -LiteralPath $OfferFile -Encoding UTF8
        $Intro='这台电脑上 Codex 的命令隔离现在是普通模式：白名单外写不进，但能删文件。'+"`r`n"+'建议提高到提权模式（OpenAI 推荐的做法）：Codex 的命令改用独立的沙箱账户运行，白名单外写不进、也删不掉。'+"`r`n`r`n"
        Invoke-SandboxUpgrade $Intro | Out-Null
    } catch { $Offer.Stop() }
})
$Watch.Start(); $Timer.Start(); $Offer.Start()
try {[System.Windows.Forms.Application]::Run()}
finally {$Offer.Dispose(); $Timer.Dispose(); $Watch.Stop(); $Watch.Dispose(); $TrayForm.Dispose(); $Tray.Visible=$false; $Tray.Dispose(); $Menu.Dispose(); Remove-Item -LiteralPath $TrayStatus -ErrorAction SilentlyContinue; $Mutex.ReleaseMutex(); $Mutex.Dispose()}
} finally {
    # Also handles exceptions during setup, before the modal/run-loop finally.
    foreach ($Name in @('tray.json')) {
        $File=Join-Path $State $Name
        try {
            $Record=Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($Record.pid -eq $PID) { Remove-Item -LiteralPath $File -Force }
        } catch {}
    }
    [System.Windows.Forms.Application]::Exit()
}
