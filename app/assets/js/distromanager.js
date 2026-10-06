const { DistributionAPI } = require('helios-core/common')

const ConfigManager = require('./configmanager')

// Public GordosGang client manifest. The Minecraft server itself is exposed
// separately through Playit; this endpoint only serves launcher metadata and
// client assets. The manifest is refreshed again whenever the player presses
// Play, so a published pack update is picked up without updating the launcher.
exports.REMOTE_DISTRO_URL = 'https://josedh-1.tailb15ed6.ts.net:10000/distribution.json'

const api = new DistributionAPI(
    ConfigManager.getLauncherDirectory(),
    null, // Injected forcefully by the preloader.
    null, // Injected forcefully by the preloader.
    exports.REMOTE_DISTRO_URL,
    false
)

exports.DistroAPI = api
