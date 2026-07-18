const repositorySlug = process.env.GITHUB_REPOSITORY ?? "";
const [repositoryOwner, repositoryName] = repositorySlug.split("/");
const hasGitHubRepository = Boolean(repositoryOwner && repositoryName);

module.exports = {
  appId: "app.violetwire.viewer",
  productName: "VioletWire",
  artifactName: "VioletWire-Setup-${version}-${arch}.${ext}",
  asar: true,
  compression: "normal",
  electronUpdaterCompatibility: ">=2.16",
  directories: {
    buildResources: "build",
    output: "release",
  },
  files: ["dist/**/*", "dist-electron/**/*", "package.json"],
  extraResources: [
    { from: "build/icon.png", to: "icon.png" },
    { from: "THIRD_PARTY_NOTICES.md", to: "THIRD_PARTY_NOTICES.md" },
    { from: "vendor/native", to: "native" },
  ],
  win: {
    icon: "build/icon.png",
    executableName: "VioletWire",
    target: [{ target: "nsis", arch: ["x64"] }],
    publish: hasGitHubRepository
      ? [
          {
            provider: "github",
            owner: repositoryOwner,
            repo: repositoryName,
            releaseType: "release",
          },
        ]
      : undefined,
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "VioletWire",
    uninstallDisplayName: "VioletWire",
  },
};
