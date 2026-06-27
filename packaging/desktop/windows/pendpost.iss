; packaging/desktop/windows/pendpost.iss - Inno Setup script for the pendpost
; Windows installer. Produces pendpost-windows-setup.exe.
;
; It bundles the runtime\ dir (the pendpost file set + a pinned node.exe, assembled
; by build-bundle.mjs) plus launch.cmd, installs PER-USER to {localappdata}\pendpost
; (no admin prompt), and creates a Start-menu shortcut + an OPTIONAL "start on
; login" shortcut. The built .exe is code-signed afterwards by
; .github/workflows/release-desktop.yml (signtool); an unsigned build still works,
; it just trips SmartScreen - which is why signing is the owner-gated final step.
;
; Inputs (the workflow assembles these before iscc runs):
;   {#StagingDir}\runtime\...   the bundle (node.exe + server.mjs + lib\ + app\dist\ + data\ + ...)
;   {#StagingDir}\launch.cmd    copied next to runtime\
; Compile:
;   iscc /DMyAppVersion=1.0.0 /DStagingDir=<abs staging path> pendpost.iss

#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif
#ifndef StagingDir
  ; Default for a local compile from this dir: repo-root\build\desktop-win.
  #define StagingDir "..\..\..\build\desktop-win"
#endif

[Setup]
; A FIXED AppId so a new version upgrades the prior install in place. Never change it.
AppId={{8F3A6C2E-9D14-4B7A-AE21-3C5F0B9D77E2}
AppName=pendpost
AppVersion={#MyAppVersion}
AppPublisher=Nomadik GmbH
AppPublisherURL=https://pendpost.com
AppSupportURL=https://pendpost.com/faq
DefaultDirName={localappdata}\pendpost
DefaultGroupName=pendpost
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#StagingDir}\out
OutputBaseFilename=pendpost-windows-setup
SetupIconFile=pendpost.ico
UninstallDisplayIcon={app}\pendpost.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; x64 node.exe; x64compatible also covers ARM64 Windows (x64 emulation).
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Tasks]
Name: "startup"; Description: "Start pendpost automatically when I sign in (so scheduled posts keep publishing)"; Flags: unchecked

[Files]
Source: "{#StagingDir}\runtime\*"; DestDir: "{app}\runtime"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#StagingDir}\launch.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "pendpost.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\pendpost"; Filename: "{app}\launch.cmd"; IconFilename: "{app}\pendpost.ico"; Flags: runminimized
Name: "{userstartup}\pendpost"; Filename: "{app}\launch.cmd"; IconFilename: "{app}\pendpost.ico"; Flags: runminimized; Tasks: startup

[Run]
Filename: "{app}\launch.cmd"; Description: "Open pendpost now"; Flags: postinstall nowait runminimized skipifsilent
