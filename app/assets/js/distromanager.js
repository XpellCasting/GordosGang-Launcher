const { DistributionAPI } = require('helios-core/common')

const ConfigManager = require('./configmanager')

// Public Homestead client manifest. The Minecraft server itself is exposed
// separately through Playit; this endpoint only serves launcher metadata and
// client assets.
exports.REMOTE_DISTRO_URL = 'https://josedh-1.tailb15ed6.ts.net:10000/distribution.json'

const api = new DistributionAPI(
    ConfigManager.getLauncherDirectory(),
    null, // Injected forcefully by the preloader.
    null, // Injected forcefully by the preloader.
    exports.REMOTE_DISTRO_URL,
    false
)

exports.DistroAPI = api
