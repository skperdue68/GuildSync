#ifndef MyAppVersion
#define MyAppVersion "1.4.4"
#endif
#define MyAppNumericVersion "1.4.4"
#ifndef SourceRoot
#define SourceRoot "payload"
#endif
#ifndef OutputRoot
#define OutputRoot "installer-output"
#endif

#define MyAppName "GuildSync"
#define MyAppExeName "GuildSync.exe"

[Setup]
AppId={{8E7D5F38-9F0E-4D2A-A95A-8A6C5B8D1001}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
DefaultDirName={autopf}\GuildSync
DisableDirPage=no
DisableWelcomePage=no
DefaultGroupName=GuildSync
OutputDir={#OutputRoot}
OutputBaseFilename=GuildSync-Setup-1.4.4-Windows
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayIcon={app}\{#MyAppExeName}
VersionInfoVersion={#MyAppNumericVersion}
VersionInfoProductVersion={#MyAppNumericVersion}
VersionInfoCompany=evainefaye
VersionInfoDescription=GuildSync Installer
VersionInfoProductName=GuildSync


[Files]
Source: "{#SourceRoot}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion; Excludes: "ESO\*,GuildSyncSettings.txt"
Source: "{#SourceRoot}\GuildSyncSettings.txt"; DestDir: "{app}"; Flags: ignoreversion onlyifdoesntexist uninsneveruninstall
Source: "{#SourceRoot}\ESO\GuildSyncBanking\*"; DestDir: "{code:GetESOAddonDir}\GuildSyncBanking"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#SourceRoot}\ESO\GuildSyncRoster\*"; DestDir: "{code:GetESOAddonDir}\GuildSyncRoster"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#SourceRoot}\ESO\GuildSyncApplications\*"; DestDir: "{code:GetESOAddonDir}\GuildSyncApplications"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\GuildSync"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\GuildSync"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: checkedonce

[Run]
Filename: "{cmd}"; Parameters: "/C if not exist ""{app}\.env"" if exist ""{app}\.env.example"" copy ""{app}\.env.example"" ""{app}\.env"""; Flags: runhidden

[Code]
var
  ESOAddonPage: TInputDirWizardPage;

procedure InitializeWizard;
begin
  WizardForm.WelcomeLabel2.Caption := 'This installer will install GuildSync version {#MyAppVersion} on your computer.';
  ESOAddonPage :=
    CreateInputDirPage(
      wpSelectDir,
      'ESO AddOns Location',
      'Where are your Elder Scrolls Online AddOns located?',
      'Select your ESO AddOns folder. The installer will copy the GuildSync add-ons into this folder.',
      False,
      ''
    );

  ESOAddonPage.Add('');

  ESOAddonPage.Values[0] :=
    ExpandConstant('{userdocs}\Elder Scrolls Online\live\AddOns');
end;

function GetESOAddonDir(Param: String): String;
begin
  Result := ESOAddonPage.Values[0];
end;

