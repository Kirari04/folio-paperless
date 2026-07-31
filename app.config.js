const packageJson = require('./package.json');

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_COMPONENT = 999;

function getVersionInfo(version) {
  const match = SEMVER_PATTERN.exec(version);

  if (!match) {
    throw new Error(
      `[app.config.js] package.json version "${version}" must be a stable MAJOR.MINOR.PATCH SemVer without a prerelease or build suffix.`,
    );
  }

  const [major, minor, patch] = match.slice(1).map(Number);
  if ([major, minor, patch].some((component) => component > MAX_COMPONENT)) {
    throw new Error(
      `[app.config.js] SemVer components must not exceed ${MAX_COMPONENT}; received "${version}".`,
    );
  }

  return {
    version,
    versionCode: major * 1_000_000 + minor * 1_000 + patch,
  };
}

module.exports = ({ config: staticConfig }) => {
  const { version, versionCode } = getVersionInfo(packageJson.version);

  return {
    ...staticConfig,
    version,
    android: {
      ...staticConfig.android,
      versionCode,
    },
  };
};
