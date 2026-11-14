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
function WantsRelaunch: Boolean;
begin
  Result := WizardSilent and (Pos('/RELAUNCH', UpperCase(GetCmdTail)) > 0);
end;
