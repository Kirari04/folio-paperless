const fs = require("node:fs");
const path = require("node:path");

const {
  createRunOncePlugin,
  withFinalizedMod,
} = require("@expo/config-plugins");
const plist = require("@expo/plist").default;
const withNotifications = require("expo-notifications/app.plugin").default;

function withLocalNotifications(config, props = {}) {
  // Folio schedules local notifications only. The upstream plugin also adds
  // aps-environment on iOS, which is a remote-push entitlement and complicates
  // personal-account sideloading without providing any Folio functionality.
  config = withNotifications(config, props);
  return withFinalizedMod(config, [
    "ios",
    async (finalizedConfig) => {
      const projectName = finalizedConfig.modRequest.projectName;
      if (!projectName) {
        throw new Error(
          "[withLocalNotifications] Could not determine the iOS project name.",
        );
      }

      const entitlementsPath = path.join(
        finalizedConfig.modRequest.platformProjectRoot,
        projectName,
        `${projectName}.entitlements`,
      );
      if (!fs.existsSync(entitlementsPath)) return finalizedConfig;

      const entitlements = plist.parse(
        fs.readFileSync(entitlementsPath, "utf8"),
      );
      delete entitlements["aps-environment"];
      fs.writeFileSync(entitlementsPath, plist.build(entitlements));
      return finalizedConfig;
    },
  ]);
}

module.exports = createRunOncePlugin(
  withLocalNotifications,
  "folio-local-notifications",
  "1.0.0",
);
module.exports.withLocalNotifications = withLocalNotifications;
