; VioletWire (Rust) installer, built by build-installer.ps1 with Inno Setup 6.
; Per-user, like Electron's NSIS installer: no administrator rights needed.
; The app updates itself by downloading a newer one of these, checking its
; SHA-256 against the release's violetwire-rust.json, and running it with
; /SILENT /RELAUNCH.

#ifndef AppVersion
  #error AppVersion must be defined (/DAppVersion=x.y.z)
#endif
#ifndef BuildDir
  #error BuildDir must be defined (/DBuildDir=<folder with violetwire.exe>)
#endif
#define Root "..\.."

[Setup]
AppId={{6F0B9C2E-6E51-4F2D-9A3B-4D6A2E7C9B10}
AppName=VioletWire
AppVersion={#AppVersion}
AppVerName=VioletWire {#AppVersion}
AppPublisher=VioletWire
AppPublisherURL=https://github.com/lucaboox/VioletWire
DefaultDirName={localappdata}\Programs\VioletWire Rust
DefaultGroupName=VioletWire
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#BuildDir}\installer
OutputBaseFilename=VioletWire-Rust-Setup-{#AppVersion}-x64
SetupIconFile={#Root}\rust\app\assets\violetwire.ico
UninstallDisplayIcon={app}\VioletWire.exe
UninstallDisplayName=VioletWire
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Closes a running VioletWire before replacing it.
CloseApplications=yes
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
; Offered only where the Electron build is installed. A silent install
; ignores this and removes it only when asked to with /REMOVEELECTRON, which
; is how the last Electron release hands over.
Name: "removeelectron"; Description: "Remove the previous VioletWire (this version replaces it)"; GroupDescription: "Previous version:"; Check: ElectronInstalled

[InstallDelete]
; A new Streamlink replaces the old one entirely.
Type: filesandordirs; Name: "{app}\streamlink"

[Files]
Source: "{#BuildDir}\violetwire.exe"; DestDir: "{app}"; DestName: "VioletWire.exe"; Flags: ignoreversion
; Streamlink, as Electron bundles it (scripts/prepare-native-runtime.ps1
; downloads a pinned build and checks its SHA-256).
Source: "{#Root}\vendor\native\streamlink\*"; DestDir: "{app}\streamlink"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Root}\vendor\native\NATIVE_RUNTIME_SOURCES.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Root}\THIRD_PARTY_NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Root}\rust\app\assets\fonts\Inter-LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\VioletWire"; Filename: "{app}\VioletWire.exe"
Name: "{autodesktop}\VioletWire"; Filename: "{app}\VioletWire.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\VioletWire.exe"; Description: "Launch VioletWire"; Flags: nowait postinstall skipifsilent
; After a silent update started by the app.
Filename: "{app}\VioletWire.exe"; Flags: nowait; Check: WantsRelaunch

[Code]
const
  { The Electron build's uninstall entry: electron-builder derives this GUID
    from its appId (app.violetwire.viewer), so it is the same on every PC.
    It is under HKLM for an all-users install and HKCU for a per-user one. }
  ElectronKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\8f878acb-194a-5426-878b-dca0e26b7ac1';
  ElectronUninstaller = 'uninstall violetwire.exe';

function HasSwitch(const Name: String): Boolean;
begin
  Result := Pos(Name, UpperCase(GetCmdTail)) > 0;
end;

function WantsRelaunch: Boolean;
begin
  Result := WizardSilent and HasSwitch('/RELAUNCH');
end;

{ The Electron build's own silent uninstall command, split into its program
  and arguments: "<folder>\Uninstall VioletWire.exe" /allusers /S }
function ElectronUninstall(var Exe, Params: String): Boolean;
var
  Command: String;
  Closing: Integer;
begin
  Result := False;
  if not (RegQueryStringValue(HKLM, ElectronKey, 'QuietUninstallString', Command)
    or RegQueryStringValue(HKCU, ElectronKey, 'QuietUninstallString', Command)) then
    Exit;
  Command := Trim(Command);
  if (Length(Command) < 3) or (Command[1] <> '"') then
    Exit;
  Delete(Command, 1, 1);
  Closing := Pos('"', Command);
  if Closing = 0 then
    Exit;
  Exe := Copy(Command, 1, Closing - 1);
  Params := Trim(Copy(Command, Closing + 1, Length(Command)));
  Result := (Lowercase(ExtractFileName(Exe)) = ElectronUninstaller) and FileExists(Exe);
end;

function ElectronInstalled: Boolean;
var
  Exe, Params: String;
begin
  Result := ElectronUninstall(Exe, Params);
end;

{ Whether Electron's uninstaller is still at work. It copies itself to the
  temporary folder as Un_A.exe and the original returns at once, so waiting
  on the process that was started says nothing. }
function ElectronUninstallerRunning: Boolean;
var
  Locator, Services, Processes: Variant;
begin
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Services := Locator.ConnectServer('.', 'root\cimv2');
    Processes := Services.ExecQuery(
      'SELECT ProcessId FROM Win32_Process WHERE Name LIKE "Un[_]_.exe" OR Name = "Uninstall VioletWire.exe"');
    Result := Processes.Count > 0;
  except
    { Cannot tell: keep waiting for the entry to go, up to the time limit. }
    Result := True;
  end;
end;

function ShouldRemoveElectron: Boolean;
begin
  if WizardSilent then
    Result := HasSwitch('/REMOVEELECTRON')
  else
    Result := WizardIsTaskSelected('removeelectron');
  Result := Result and ElectronInstalled;
end;

{ Runs Electron's uninstaller and waits for it. It closes the Electron app
  if it is open, and asks for administrator rights itself when that install
  is for all users. Declining, or any failure, leaves Electron in place and
  this install carries on. Electron's settings folder is kept: this app
  brings the viewer's preferences over from it on first run. }
procedure RemoveElectron;
var
  Exe, Params: String;
  Code, Waited: Integer;
begin
  if not ElectronUninstall(Exe, Params) then
    Exit;
  WizardForm.StatusLabel.Caption := 'Removing the previous VioletWire...';
  if not Exec(Exe, Params, '', SW_SHOWNORMAL, ewNoWait, Code) then
    Exit;
  Waited := 0;
  while Waited < 180000 do
  begin
    Sleep(500);
    Waited := Waited + 500;
    if not ElectronInstalled then
      Break;
    if (Waited >= 5000) and not ElectronUninstallerRunning then
      Break;
  end;
end;

{ Before any file or shortcut of this install is written: a per-user
  Electron install has its desktop shortcut where this one goes, and its
  uninstaller deletes it. }
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssInstall) and ShouldRemoveElectron then
    RemoveElectron;
end;
