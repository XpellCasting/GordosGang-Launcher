/**
 * Script for landing.ejs
 */
// Requirements
const { URL }                 = require('url')
const {
    getServerStatus
}                             = require('helios-core/mojang')
const {
    isDisplayableError,
    validateLocalFile
}                             = require('helios-core/common')
const {
    FullRepair,
    DistributionIndexProcessor,
    MojangIndexProcessor,
    downloadFile
}                             = require('helios-core/dl')
const {
    validateSelectedJvm,
    ensureJavaDirIsRoot,
    javaExecFromRoot,
    discoverBestJvmInstallation,
    latestOpenJDK,
    extractJdk
}                             = require('helios-core/java')

// Internal Requirements
const DiscordWrapper          = require('./assets/js/discordwrapper')
const ProcessBuilder          = require('./assets/js/processbuilder')

// Launch Elements
const launch_content          = document.getElementById('launch_content')
const launch_details          = document.getElementById('launch_details')
const launch_progress         = document.getElementById('launch_progress')
const launch_progress_label   = document.getElementById('launch_progress_label')
const launch_details_text     = document.getElementById('launch_details_text')
const server_selection_button = document.getElementById('server_selection_button')
const user_text               = document.getElementById('user_text')
const avatarStage             = document.getElementById('avatarStage')
const avatarContainer         = document.getElementById('avatarContainer')
const avatarOverlay           = document.getElementById('avatarOverlay')

const loggerLanding = LoggerUtil.getLogger('Landing')

/* Launch Progress Wrapper Functions */

/**
 * Show/hide the loading area.
 * 
 * @param {boolean} loading True if the loading area should be shown, otherwise false.
 */
function toggleLaunchArea(loading){
    if(loading){
        launch_details.style.display = 'flex'
        launch_content.style.display = 'none'
    } else {
        launch_details.style.display = 'none'
        launch_content.style.display = 'inline-flex'
    }
}

/**
 * Set the details text of the loading area.
 * 
 * @param {string} details The new text for the loading details.
 */
function setLaunchDetails(details){
    launch_details_text.innerHTML = details
}

/**
 * Set the value of the loading progress bar and display that value.
 * 
 * @param {number} percent Percentage (0-100)
 */
function setLaunchPercentage(percent){
    launch_progress.setAttribute('max', 100)
    launch_progress.setAttribute('value', percent)
    launch_progress_label.innerHTML = percent + '%'
}

/**
 * Set the value of the OS progress bar and display that on the UI.
 * 
 * @param {number} percent Percentage (0-100)
 */
function setDownloadPercentage(percent){
    remote.getCurrentWindow().setProgressBar(percent/100)
    setLaunchPercentage(percent)
}

/**
 * Enable or disable the launch button.
 * 
 * @param {boolean} val True to enable, false to disable.
 */
function setLaunchEnabled(val){
    document.getElementById('launch_button').disabled = !val
}

// Bind launch button
document.getElementById('launch_button').addEventListener('click', async e => {
    loggerLanding.info('Launching game..')
    try {
        const server = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())
        const jExe = ConfigManager.getJavaExecutable(ConfigManager.getSelectedServer())
        if(jExe == null){
            await asyncSystemScan(server.effectiveJavaOptions)
        } else {

            setLaunchDetails(Lang.queryJS('landing.launch.pleaseWait'))
            toggleLaunchArea(true)
            setLaunchPercentage(0, 100)

            const details = await validateSelectedJvm(ensureJavaDirIsRoot(jExe), server.effectiveJavaOptions.supported)
            if(details != null){
                loggerLanding.info('Jvm Details', details)
                await dlAsync()

            } else {
                await asyncSystemScan(server.effectiveJavaOptions)
            }
        }
    } catch(err) {
        loggerLanding.error('Unhandled error in during launch process.', err)
        showLaunchFailure(Lang.queryJS('landing.launch.failureTitle'), Lang.queryJS('landing.launch.failureText'))
    }
})

// Bind settings button
document.getElementById('settingsMediaButton').onclick = async e => {
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings)
}

// Bind avatar overlay button.
avatarOverlay.onclick = async e => {
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
        settingsNavItemListener(document.getElementById('settingsNavAccount'), false)
    })
}

// Give the player preview a small, pointer-driven sense of depth. This only
// runs while the pointer is over the preview and never creates a render loop.
let avatarTiltFrame = null
let avatarPointerX = 0
let avatarPointerY = 0
let avatarBounds = null
const avatarReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

avatarStage.addEventListener('pointerenter', () => {
    avatarBounds = avatarStage.getBoundingClientRect()
})

avatarStage.addEventListener('pointermove', e => {
    if(avatarReducedMotion.matches){
        return
    }

    avatarPointerX = e.clientX
    avatarPointerY = e.clientY
    if(avatarTiltFrame != null){
        return
    }

    avatarTiltFrame = window.requestAnimationFrame(() => {
        if(avatarBounds != null){
            const x = ((avatarPointerX - avatarBounds.left) / avatarBounds.width) - 0.5
            const y = ((avatarPointerY - avatarBounds.top) / avatarBounds.height) - 0.5
            avatarStage.style.setProperty('--avatar-tilt-x', `${(-y * 7).toFixed(2)}deg`)
            avatarStage.style.setProperty('--avatar-tilt-y', `${(x * 9).toFixed(2)}deg`)
        }
        avatarTiltFrame = null
    })
})

avatarStage.addEventListener('pointerleave', () => {
    avatarBounds = null
    avatarStage.style.setProperty('--avatar-tilt-x', '0deg')
    avatarStage.style.setProperty('--avatar-tilt-y', '0deg')
})

// Bind selected account
function updateSelectedAccount(authUser){
    let username = Lang.queryJS('landing.selectedAccount.noAccountSelected')
    let hasSkin = false
    if(authUser != null){
        if(authUser.displayName != null){
            username = authUser.displayName
        }
        if(authUser.uuid != null){
            hasSkin = true
        }
    }
    avatarContainer.style.removeProperty('background-image')
    if(hasSkin){
        const uuid = authUser.uuid
        avatarContainer.dataset.skinUuid = uuid
        SkinResolver.renderURL(uuid, 'head', 'right').then(url => {
            // A later account switch may have resolved first.
            if(avatarContainer.dataset.skinUuid === uuid){
                avatarContainer.style.backgroundImage = `url('${url}')`
            }
        })
    } else {
        delete avatarContainer.dataset.skinUuid
    }
    avatarStage.classList.toggle('avatarStage--empty', !hasSkin)
    user_text.textContent = username
    user_text.title = username
    avatarOverlay.setAttribute('aria-label', `${Lang.queryJS('landing.usernameEditButton')}: ${username}`)
}
updateSelectedAccount(ConfigManager.getSelectedAccount())

// Bind selected server
function updateSelectedServer(serv){
    if(getCurrentView() === VIEWS.settings){
        fullSettingsSave()
    }
    ConfigManager.setSelectedServer(serv != null ? serv.rawServer.id : null)
    ConfigManager.save()
    server_selection_button.innerHTML = '&#8226; ' + (serv != null ? serv.rawServer.name : Lang.queryJS('landing.noSelection'))
    if(getCurrentView() === VIEWS.settings){
        animateSettingsTabRefresh()
    }
    setLaunchEnabled(serv != null)
}
// Real text is set in uibinder.js on distributionIndexDone.
server_selection_button.innerHTML = '&#8226; ' + Lang.queryJS('landing.selectedServer.loading')
server_selection_button.onclick = async e => {
    e.target.blur()
    await toggleServerSelection(true)
}

/* Server card */

const serverCard            = document.getElementById('serverCard')
const serverCardIcon        = document.getElementById('serverCardIcon')
const serverCardName        = document.getElementById('serverCardName')
const serverCardStatusText  = document.getElementById('serverCardStatusText')
const serverCardLatency     = document.getElementById('serverCardLatency')
const serverCardMotd        = document.getElementById('serverCardMotd')
const serverCardMeter       = document.getElementById('serverCardMeter')
const serverCardPlayerText  = document.getElementById('serverCardPlayerText')
const serverCardHeads       = document.getElementById('serverCardHeads')
const serverCardVersion     = document.getElementById('serverCardVersion')
const serverCardAddress     = document.getElementById('serverCardAddress')
const serverCardAddressText = document.getElementById('serverCardAddressText')

const SERVER_STATUS_PROTOCOL = 763
const SERVER_CARD_MAX_CELLS  = 20
const SERVER_CARD_MAX_HEADS  = 5

// Minecraft's formatting palette, with the two near-black greys lifted so
// they stay legible on the night surfaces.
const MOTD_COLORS = {
    '0': 'var(--text-3)', '1': '#6c7bff', '2': '#45c46a', '3': '#45c9c9',
    '4': '#e5525d', '5': '#c66bff', '6': '#ffb65c', '7': '#cdc6df',
    '8': 'var(--text-3)', '9': '#8392ff', 'a': '#72e38e', 'b': '#72e8f2',
    'c': '#ff6f79', 'd': '#f190ff', 'e': '#ffe27a', 'f': '#f7f2ff'
}
const MOTD_NAMED_COLORS = [
    'black', 'dark_blue', 'dark_green', 'dark_aqua', 'dark_red', 'dark_purple', 'gold', 'gray',
    'dark_gray', 'blue', 'green', 'aqua', 'red', 'light_purple', 'yellow', 'white'
]

/**
 * The status packet is read as Latin-1, so UTF-8 text such as `§` or `»`
 * arrives as `Â§` / `Â»`. Undo that when the telltale pattern is present.
 */
function repairStatusText(text){
    if(!/[ÂÃ][\u0080-\u00BF]/.test(text)){
        return text
    }
    const repaired = Buffer.from(text, 'latin1').toString('utf8')
    return repaired.includes('\uFFFD') ? text : repaired
}

/**
 * Flatten a chat component into legacy `§` formatted text.
 */
function chatToLegacy(component){
    if(component == null) return ''
    if(typeof component === 'string') return component
    if(Array.isArray(component)) return component.map(chatToLegacy).join('')
    let out = ''
    const colorIndex = MOTD_NAMED_COLORS.indexOf(component.color)
    if(colorIndex >= 0) out += '§' + colorIndex.toString(16)
    if(component.bold) out += '§l'
    if(component.italic) out += '§o'
    out += component.text ?? ''
    if(component.extra) out += chatToLegacy(component.extra)
    return out
}

/**
 * Render `§` formatted text into an element without ever parsing it as HTML.
 */
function renderMotd(el, text){
    el.replaceChildren()
    let style = {}
    for(const part of text.split(/(§[0-9a-fk-or])/i)){
        const code = /^§([0-9a-fk-or])$/i.exec(part)?.[1].toLowerCase()
        if(code != null){
            if(code in MOTD_COLORS) style = { color: MOTD_COLORS[code] }
            else if(code === 'r') style = {}
            else if(code === 'l') style.bold = true
            else if(code === 'o') style.italic = true
            else if(code === 'n') style.underline = true
            else if(code === 'm') style.strike = true
            continue
        }
        if(part === '') continue
        const span = document.createElement('span')
        span.textContent = part
        if(style.color) span.style.color = style.color
        if(style.bold) span.style.fontWeight = '700'
        if(style.italic) span.style.fontStyle = 'italic'
        const decoration = [style.underline && 'underline', style.strike && 'line-through'].filter(Boolean).join(' ')
        if(decoration) span.style.textDecoration = decoration
        el.appendChild(span)
    }
}

function renderPlayerMeter(online, max){
    const cells = Math.max(1, Math.min(max || 1, SERVER_CARD_MAX_CELLS))
    const filled = max > 0 ? Math.round(Math.min(online, max) / max * cells) : 0
    serverCardMeter.replaceChildren(...Array.from({ length: cells }, (_, i) => {
        const cell = document.createElement('i')
        if(i < filled) cell.className = 'is-filled'
        return cell
    }))
    gsap.fromTo(serverCardMeter.querySelectorAll('.is-filled'),
        { opacity: 0, scaleY: 0.4 },
        { opacity: 1, scaleY: 1, duration: 0.24, ease: 'power2.out', stagger: 0.03, clearProps: 'all' })
}

function renderPlayerHeads(sample, online){
    const shown = (sample || []).slice(0, SERVER_CARD_MAX_HEADS)
    const heads = shown.map(({ id, name }) => {
        const img = document.createElement('img')
        img.src = `https://mc-heads.net/avatar/${id}/24`
        img.alt = name
        img.title = name
        img.width = 24
        img.height = 24
        img.dataset.skinUuid = id
        img.dataset.skinView = 'avatar'
        img.dataset.skinVariant = '24'
        return img
    })
    const extra = online - shown.length
    if(shown.length > 0 && extra > 0){
        const more = document.createElement('span')
        more.className = 'serverCardMore'
        more.textContent = Lang.queryJS('landing.serverCard.more', { count: extra })
        heads.push(more)
    }
    serverCardHeads.replaceChildren(...heads)
    SkinResolver.applyTo(serverCardHeads)
}

function renderServerIdentity(serv){
    serverCardName.textContent = serv.rawServer.name
    serverCardVersion.textContent = serv.rawServer.description || serv.rawServer.minecraftVersion
    const address = serv.rawServer.address.replace(/:25565$/, '')
    serverCardAddressText.textContent = address
    serverCardAddress.dataset.address = address
}

function renderServerStatus(status, latency){
    const online = status != null
    serverCard.dataset.state = online ? 'online' : 'offline'
    serverCardStatusText.textContent = Lang.queryJS(online ? 'landing.serverCard.online' : 'landing.serverCard.offline')
    serverCardLatency.textContent = online ? Lang.queryJS('landing.serverCard.latency', { ms: latency }) : ''

    if(online){
        renderMotd(serverCardMotd, repairStatusText(chatToLegacy(status.description)))
        const { online: count, max, sample } = status.players
        serverCardPlayerText.textContent = count > 0
            ? Lang.queryJS('landing.serverCard.players', { online: count, max })
            : Lang.queryJS('landing.serverCard.noPlayers', { max })
        renderPlayerMeter(count, max)
        renderPlayerHeads(sample, count)
        serverCardIcon.src = /^data:image\/png;base64,/.test(status.favicon ?? '') ? status.favicon : './assets/images/AppIcon.png'
    } else {
        serverCardMotd.textContent = Lang.queryJS('landing.serverCard.offlineHint')
        serverCardPlayerText.textContent = ''
        serverCardMeter.replaceChildren()
        serverCardHeads.replaceChildren()
        serverCardIcon.src = './assets/images/AppIcon.png'
    }
}

let serverStatusRequest = 0

/**
 * Query the selected server and refresh the card.
 *
 * @param {boolean} fade True to crossfade the card's live content.
 */
const refreshServerStatus = async (fade = false) => {
    loggerLanding.info('Refreshing Server Status')
    const request = ++serverStatusRequest
    const serv = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())
    if(serv == null) return
    renderServerIdentity(serv)

    let status = null
    let latency = null
    const started = performance.now()
    try {
        status = await getServerStatus(SERVER_STATUS_PROTOCOL, serv.hostname, serv.port)
        latency = Math.round(performance.now() - started)
    } catch (err) {
        loggerLanding.warn('Unable to refresh server status, assuming offline.')
        loggerLanding.debug(err)
    }
    if(request !== serverStatusRequest) return

    const live = [serverCardMotd, document.getElementById('serverCardPlayers'), document.getElementById('serverCardStatus')]
    if(fade){
        gsap.timeline()
            .to(live, { opacity: 0, duration: 0.14, ease: 'power1.in' })
            .call(() => renderServerStatus(status, latency))
            .to(live, { opacity: 1, duration: 0.24, ease: 'power1.out', stagger: 0.04, clearProps: 'opacity' })
    } else {
        renderServerStatus(status, latency)
    }
}

serverCardAddress.onclick = () => {
    require('electron').clipboard.writeText(serverCardAddress.dataset.address || '')
    serverCardAddress.setAttribute('data-copied', '')
    serverCardAddressText.textContent = Lang.queryJS('landing.serverCard.copied')
    clearTimeout(serverCardAddress.copyTimer)
    serverCardAddress.copyTimer = setTimeout(() => {
        serverCardAddress.removeAttribute('data-copied')
        serverCardAddressText.textContent = serverCardAddress.dataset.address
    }, 1600)
}

// Server Status is refreshed in uibinder.js on distributionIndexDone.
// A status ping is a single small packet, so the card can stay close to live.
let serverStatusListener = setInterval(() => refreshServerStatus(true), 60000)

/**
 * Shows an error overlay, toggles off the launch area.
 * 
 * @param {string} title The overlay title.
 * @param {string} desc The overlay description.
 */
function showLaunchFailure(title, desc){
    setOverlayContent(
        title,
        desc,
        Lang.queryJS('landing.launch.okay')
    )
    setOverlayHandler(null)
    toggleOverlay(true)
    toggleLaunchArea(false)
}

/* System (Java) Scan */

/**
 * Asynchronously scan the system for valid Java installations.
 * 
 * @param {boolean} launchAfter Whether we should begin to launch after scanning. 
 */
async function asyncSystemScan(effectiveJavaOptions, launchAfter = true){

    setLaunchDetails(Lang.queryJS('landing.systemScan.checking'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    const jvmDetails = await discoverBestJvmInstallation(
        ConfigManager.getDataDirectory(),
        effectiveJavaOptions.supported
    )

    if(jvmDetails == null) {
        // If the result is null, no valid Java installation was found.
        // Show this information to the user.
        setOverlayContent(
            Lang.queryJS('landing.systemScan.noCompatibleJava'),
            Lang.queryJS('landing.systemScan.installJavaMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
            Lang.queryJS('landing.systemScan.installJava'),
            Lang.queryJS('landing.systemScan.installJavaManually')
        )
        setOverlayHandler(() => {
            setLaunchDetails(Lang.queryJS('landing.systemScan.javaDownloadPrepare'))
            toggleOverlay(false)
            
            try {
                downloadJava(effectiveJavaOptions, launchAfter)
            } catch(err) {
                loggerLanding.error('Unhandled error in Java Download', err)
                showLaunchFailure(Lang.queryJS('landing.systemScan.javaDownloadFailureTitle'), Lang.queryJS('landing.systemScan.javaDownloadFailureText'))
            }
        })
        setDismissHandler(() => {
            fadeOutElement('#overlayContent').then(() => {
                setOverlayContent(
                    Lang.queryJS('landing.systemScan.javaRequired', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredDismiss'),
                    Lang.queryJS('landing.systemScan.javaRequiredCancel')
                )
                setOverlayHandler(() => {
                    toggleLaunchArea(false)
                    toggleOverlay(false)
                })
                setDismissHandler(() => {
                    toggleOverlay(false, true)

                    asyncSystemScan(effectiveJavaOptions, launchAfter)
                })
                return fadeInElement('#overlayContent')
            })
        })
        toggleOverlay(true, true)
    } else {
        // Java installation found, use this to launch the game.
        const javaExec = javaExecFromRoot(jvmDetails.path)
        ConfigManager.setJavaExecutable(ConfigManager.getSelectedServer(), javaExec)
        ConfigManager.save()

        // We need to make sure that the updated value is on the settings UI.
        // Just incase the settings UI is already open.
        settingsJavaExecVal.value = javaExec
        await populateJavaExecDetails(settingsJavaExecVal.value)

        // TODO Callback hell, refactor
        // TODO Move this out, separate concerns.
        if(launchAfter){
            await dlAsync()
        }
    }

}

async function downloadJava(effectiveJavaOptions, launchAfter = true) {

    // TODO Error handling.
    // asset can be null.
    const asset = await latestOpenJDK(
        effectiveJavaOptions.suggestedMajor,
        ConfigManager.getDataDirectory(),
        effectiveJavaOptions.distribution)

    if(asset == null) {
        throw new Error(Lang.queryJS('landing.downloadJava.findJdkFailure'))
    }

    let received = 0
    await downloadFile(asset.url, asset.path, ({ transferred }) => {
        received = transferred
        setDownloadPercentage(Math.trunc((transferred/asset.size)*100))
    })
    setDownloadPercentage(100)

    if(received != asset.size) {
        loggerLanding.warn(`Java Download: Expected ${asset.size} bytes but received ${received}`)
        if(!await validateLocalFile(asset.path, asset.algo, asset.hash)) {
            log.error(`Hashes do not match, ${asset.id} may be corrupted.`)
            // Don't know how this could happen, but report it.
            throw new Error(Lang.queryJS('landing.downloadJava.javaDownloadCorruptedError'))
        }
    }

    // Extract
    // Show installing progress bar.
    remote.getCurrentWindow().setProgressBar(2)

    // Wait for extration to complete.
    const eLStr = Lang.queryJS('landing.downloadJava.extractingJava')
    let dotStr = ''
    setLaunchDetails(eLStr)
    const extractListener = setInterval(() => {
        if(dotStr.length >= 3){
            dotStr = ''
        } else {
            dotStr += '.'
        }
        setLaunchDetails(eLStr + dotStr)
    }, 750)

    const newJavaExec = await extractJdk(asset.path)

    // Extraction complete, remove the loading from the OS progress bar.
    remote.getCurrentWindow().setProgressBar(-1)

    // Extraction completed successfully.
    ConfigManager.setJavaExecutable(ConfigManager.getSelectedServer(), newJavaExec)
    ConfigManager.save()

    clearInterval(extractListener)
    setLaunchDetails(Lang.queryJS('landing.downloadJava.javaInstalled'))

    // TODO Callback hell
    // Refactor the launch functions
    asyncSystemScan(effectiveJavaOptions, launchAfter)

}

// Keep reference to Minecraft Process
let proc
// Is DiscordRPC enabled
let hasRPC = false
// Joined server regex
// Change this if your server uses something different.
const GAME_JOINED_REGEX = /\[.+\]: Sound engine started/
const GAME_LAUNCH_REGEX = /^\[.+\]: (?:MinecraftForge .+ Initialized|ModLauncher .+ starting: .+|Loading Minecraft .+ with Fabric Loader .+)$/
const MIN_LINGER = 5000

async function dlAsync(login = true) {

    // Login parameter is temporary for debug purposes. Allows testing the validation/downloads without
    // launching the game.

    const loggerLaunchSuite = LoggerUtil.getLogger('LaunchSuite')

    setLaunchDetails(Lang.queryJS('landing.dlAsync.loadingServerInfo'))

    let distro

    try {
        distro = await DistroAPI.refreshDistributionOrFallback()
        onDistroRefresh(distro)
    } catch(err) {
        loggerLaunchSuite.error('Unable to refresh distribution index.', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.fatalError'), Lang.queryJS('landing.dlAsync.unableToLoadDistributionIndex'))
        return
    }

    const serv = distro.getServerById(ConfigManager.getSelectedServer())

    if(login) {
        if(ConfigManager.getSelectedAccount() == null){
            loggerLanding.error('You must be logged into an account.')
            return
        }
    }

    setLaunchDetails(Lang.queryJS('landing.dlAsync.pleaseWait'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    const fullRepairModule = new FullRepair(
        ConfigManager.getCommonDirectory(),
        ConfigManager.getInstanceDirectory(),
        ConfigManager.getLauncherDirectory(),
        ConfigManager.getSelectedServer(),
        DistroAPI.isDevMode()
    )

    fullRepairModule.spawnReceiver()

    fullRepairModule.childProcess.on('error', (err) => {
        loggerLaunchSuite.error('Error during launch', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), err.message || Lang.queryJS('landing.dlAsync.errorDuringLaunchText'))
    })
    fullRepairModule.childProcess.on('close', (code, _signal) => {
        if(code !== 0){
            loggerLaunchSuite.error(`Full Repair Module exited with code ${code}, assuming error.`)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
        }
    })

    loggerLaunchSuite.info('Validating files.')
    setLaunchDetails(Lang.queryJS('landing.dlAsync.validatingFileIntegrity'))
    let invalidFileCount = 0
    try {
        invalidFileCount = await fullRepairModule.verifyFiles(percent => {
            setLaunchPercentage(percent)
        })
        setLaunchPercentage(100)
    } catch (err) {
        loggerLaunchSuite.error('Error during file validation.')
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileVerificationTitle'), err.displayable || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
        return
    }
    

    if(invalidFileCount > 0) {
        loggerLaunchSuite.info('Downloading files.')
        setLaunchDetails(Lang.queryJS('landing.dlAsync.downloadingFiles'))
        setLaunchPercentage(0)
        try {
            await fullRepairModule.download(percent => {
                setDownloadPercentage(percent)
            })
            setDownloadPercentage(100)
        } catch(err) {
            loggerLaunchSuite.error('Error during file download.')
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileDownloadTitle'), err.displayable || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
            return
        }
    } else {
        loggerLaunchSuite.info('No invalid files, skipping download.')
    }

    // Remove download bar.
    remote.getCurrentWindow().setProgressBar(-1)

    fullRepairModule.destroyReceiver()

    setLaunchDetails(Lang.queryJS('landing.dlAsync.preparingToLaunch'))

    const mojangIndexProcessor = new MojangIndexProcessor(
        ConfigManager.getCommonDirectory(),
        serv.rawServer.minecraftVersion)
    const distributionIndexProcessor = new DistributionIndexProcessor(
        ConfigManager.getCommonDirectory(),
        distro,
        serv.rawServer.id
    )

    const modLoaderData = await distributionIndexProcessor.loadModLoaderVersionJson(serv)
    const versionData = await mojangIndexProcessor.getVersionJson()

    if(login) {
        const authUser = ConfigManager.getSelectedAccount()
        loggerLaunchSuite.info(`Sending selected account (${authUser.displayName}) to ProcessBuilder.`)
        let pb = new ProcessBuilder(serv, versionData, modLoaderData, authUser, remote.app.getVersion())
        setLaunchDetails(Lang.queryJS('landing.dlAsync.launchingGame'))

        // const SERVER_JOINED_REGEX = /\[.+\]: \[CHAT\] [a-zA-Z0-9_]{1,16} joined the game/
        const SERVER_JOINED_REGEX = new RegExp(`\\[.+\\]: \\[CHAT\\] ${authUser.displayName} joined the game`)

        const onLoadComplete = () => {
            toggleLaunchArea(false)
            if(ConfigManager.getHideOnGameStart()){
                hideLauncherWhilePlaying(proc)
            }
            if(hasRPC){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.loading'))
                proc.stdout.on('data', gameStateChange)
            }
            proc.stdout.removeListener('data', tempListener)
            proc.stderr.removeListener('data', gameErrorListener)
        }
        const start = Date.now()

        // Attach a temporary listener to the client output.
        // Will wait for a certain bit of text meaning that
        // the client application has started, and we can hide
        // the progress bar stuff.
        const tempListener = function(data){
            if(GAME_LAUNCH_REGEX.test(data.trim())){
                const diff = Date.now()-start
                if(diff < MIN_LINGER) {
                    setTimeout(onLoadComplete, MIN_LINGER-diff)
                } else {
                    onLoadComplete()
                }
            }
        }

        // Listener for Discord RPC.
        const gameStateChange = function(data){
            data = data.trim()
            if(SERVER_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.joined'))
            } else if(GAME_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.joining'))
            }
        }

        const gameErrorListener = function(data){
            data = data.trim()
            if(data.indexOf('Could not find or load main class net.minecraft.launchwrapper.Launch') > -1){
                loggerLaunchSuite.error('Game launch failed, LaunchWrapper was not downloaded properly.')
                showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.launchWrapperNotDownloaded'))
            }
        }

        try {
            // Build Minecraft process.
            proc = pb.build()

            // Bind listeners to stdout.
            proc.stdout.on('data', tempListener)
            proc.stderr.on('data', gameErrorListener)

            setLaunchDetails(Lang.queryJS('landing.dlAsync.doneEnjoyServer'))

            // Init Discord Hook
            if(distro.rawDistribution.discord != null && serv.rawServer.discord != null){
                DiscordWrapper.initRPC(distro.rawDistribution.discord, serv.rawServer.discord)
                hasRPC = true
                proc.on('close', (code, signal) => {
                    loggerLaunchSuite.info('Shutting down Discord Rich Presence..')
                    DiscordWrapper.shutdownRPC()
                    hasRPC = false
                    proc = null
                })
            }

        } catch(err) {

            loggerLaunchSuite.error('Error during launch', err)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.checkConsoleForDetails'))

        }
    }

}

/**
 * Step aside while the game runs and come back when it exits, so a crash
 * still lands on a window that can explain it.
 *
 * @param {ChildProcess} gameProcess The running Minecraft process.
 */
function hideLauncherWhilePlaying(gameProcess){
    const win = remote.getCurrentWindow()
    win.hide()
    gameProcess.once('close', () => {
        win.show()
        win.focus()
    })
}

/**
 * News Loading Functions
 */

// DOM Cache
const newsContainer                 = document.getElementById('newsContainer')
const newsPanel                     = document.getElementById('newsPanel')
const newsContent                   = document.getElementById('newsContent')
const newsHeading                   = document.getElementById('newsHeading')
const newsArticleTitle              = document.getElementById('newsArticleTitle')
const newsArticleDate               = document.getElementById('newsArticleDate')
const newsArticleAuthor             = document.getElementById('newsArticleAuthor')
const newsArticleLink               = document.getElementById('newsArticleLink')
const newsNavigationStatus          = document.getElementById('newsNavigationStatus')
const newsArticleContentScrollable  = document.getElementById('newsArticleContentScrollable')
const nELoadSpan                    = document.getElementById('nELoadSpan')

// News panel state.
let newsActive = false

function sanitizeNewsBrand(value){
    return String(value ?? '')
        .replace(/Helios(?:\s|-)+Launcher/gi, 'GordosGang Launcher')
        .replace(/\bUTGC\b/g, 'GordosGang')
}

// The renderer runs with Node integration, so feed markup must never carry
// anything executable into the page.
const NEWS_BLOCKED_TAGS = 'script, style, iframe, frame, object, embed, link, meta, base, form, input, button, textarea, select'

/**
 * Turn feed HTML into inert markup that is safe to insert into the page.
 *
 * @param {string} html Raw article HTML from the feed.
 * @param {string} host Origin used to resolve relative URLs.
 * @returns {string} Sanitized HTML.
 */
function sanitizeNewsHTML(html, host){
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
    doc.body.querySelectorAll(NEWS_BLOCKED_TAGS).forEach(el => el.remove())
    doc.body.querySelectorAll('*').forEach(el => {
        for(const attr of Array.from(el.attributes)){
            const name = attr.name.toLowerCase()
            if(name.startsWith('on') || name === 'style' || name === 'srcdoc'){
                el.removeAttribute(attr.name)
            } else if(name === 'href' || name === 'src'){
                let url
                try {
                    url = new URL(attr.value, host)
                } catch {
                    el.removeAttribute(attr.name)
                    continue
                }
                if(url.protocol === 'http:' || url.protocol === 'https:'){
                    el.setAttribute(attr.name, url.href)
                } else {
                    el.removeAttribute(attr.name)
                }
            }
        }
        if(el.tagName === 'IMG'){
            el.setAttribute('loading', 'lazy')
            el.setAttribute('alt', el.getAttribute('alt') || '')
        }
    })
    return doc.body.innerHTML
}

const newsDateFormat = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })

/**
 * Open or close the news panel.
 * 
 * @param {boolean} up True to open, otherwise false.
 */
function slide_(up){
    const lCUpper = document.querySelector('#landingContainer > #upper')
    const lCLLeft = document.querySelector('#landingContainer > #lower > #left')
    const lCLRight = document.querySelector('#landingContainer > #lower > #right')
    const landingContainer = document.getElementById('landingContainer')
    const landingSections = [lCUpper, lCLLeft, lCLRight]

    gsap.killTweensOf([...landingSections, newsContainer, newsPanel])

    if(up){
        landingContainer.classList.add('news-open')
        newsContainer.classList.add('is-open')
        gsap.timeline()
            .to(landingSections, { opacity: 0, y: -12, duration: 0.14, ease: 'power2.in', stagger: 0.02 })
            .set(landingSections, { visibility: 'hidden' })
            .fromTo(newsContainer, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2, ease: 'power1.out' }, 0.04)
            .fromTo(newsPanel, { y: 28, opacity: 0 }, { y: 0, opacity: 1, duration: 0.34, ease: 'power3.out' }, 0.08)
    } else {
        landingContainer.classList.remove('news-open')
        gsap.timeline({ onComplete: () => newsContainer.classList.remove('is-open') })
            .to(newsPanel, { y: 20, opacity: 0, duration: 0.16, ease: 'power2.in' })
            .to(newsContainer, { autoAlpha: 0, duration: 0.16, ease: 'power1.in' }, 0.06)
            .set(landingSections, { visibility: 'visible' }, 0.1)
            .to(landingSections, { opacity: 1, y: 0, duration: 0.22, ease: 'power3.out', stagger: 0.03, clearProps: 'transform' }, 0.1)
    }
}

// Bind news button.
document.getElementById('newsButton').onclick = () => {
    // Toggle tabbing.
    if(newsActive){
        $('#landingContainer *').removeAttr('tabindex')
        $('#newsContainer *').attr('tabindex', '-1')
    } else {
        $('#landingContainer *').attr('tabindex', '-1')
        $('#newsContainer, #newsContainer *, #lower, #lower #center *').removeAttr('tabindex')
        if(newsAlertShown){
            fadeOutElement('#newsButtonAlert')
            newsAlertShown = false
            ConfigManager.setNewsCacheDismissed(true)
            ConfigManager.save()
        }
    }
    slide_(!newsActive)
    newsActive = !newsActive
}

// Array to store article meta.
let newsArr = null

/**
 * Set the news loading label.
 * 
 * @param {boolean} val True when news are being fetched.
 */
function setNewsLoading(val){
    if(val){
        // The pixel loader beside this label carries the motion.
        nELoadSpan.textContent = Lang.queryJS('landing.news.checking')
    }
}

// Bind retry button.
newsErrorRetry.onclick = async () => {
    await fadeOutElement('#newsErrorFailed')
    fadeInElement('#newsErrorLoading')
    initNews()
}

newsArticleContentScrollable.onscroll = (e) => {
    if(e.target.scrollTop > 0){
        newsContent.setAttribute('scrolled', '')
    } else {
        newsContent.removeAttribute('scrolled')
    }
}

/**
 * Reload the news without restarting.
 * 
 * @returns {Promise.<void>} A promise which resolves when the news
 * content has finished loading and transitioning.
 */
async function reloadNews(){
    await fadeOutElement('#newsContent')
    document.getElementById('newsErrorContainer').style.display = ''
    $('#newsErrorFailed, #newsErrorNone').hide()
    await fadeInElement('#newsErrorLoading')
    await initNews()
}

let newsAlertShown = false

/**
 * Show the news alert indicating there is new news.
 */
function showNewsAlert(){
    newsAlertShown = true
    fadeInElement('#newsButtonAlert', 0.25)
}

async function digestMessage(str) {
    const msgUint8 = new TextEncoder().encode(str)
    const hashBuffer = await crypto.subtle.digest('SHA-1', msgUint8)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    return hashHex
}

/**
 * Initialize News UI. This will load the news and prepare
 * the UI accordingly.
 * 
 * @returns {Promise.<void>} A promise which resolves when the news
 * content has finished loading and transitioning.
 */
async function initNews(){

    setNewsLoading(true)

    const news = await loadNews()

    newsArr = news?.articles || null

    if(newsArr == null){
        // News Loading Failed
        setNewsLoading(false)

        await fadeOutElement('#newsErrorLoading')
        await fadeInElement('#newsErrorFailed')

    } else if(newsArr.length === 0) {
        // No News Articles
        setNewsLoading(false)

        ConfigManager.setNewsCache({
            date: null,
            content: null,
            dismissed: false
        })
        ConfigManager.save()

        await fadeOutElement('#newsErrorLoading')
        await fadeInElement('#newsErrorNone')
    } else {
        // Success
        setNewsLoading(false)

        const lN = newsArr[0]
        const cached = ConfigManager.getNewsCache()
        let newHash = await digestMessage(lN.content)
        let newDate = new Date(lN.timestamp)
        let isNew = false

        if(cached.date != null && cached.content != null){

            if(new Date(cached.date) >= newDate){

                // Compare Content
                if(cached.content !== newHash){
                    isNew = true
                    showNewsAlert()
                } else {
                    if(!cached.dismissed){
                        isNew = true
                        showNewsAlert()
                    }
                }

            } else {
                isNew = true
                showNewsAlert()
            }

        } else {
            isNew = true
            showNewsAlert()
        }

        if(isNew){
            ConfigManager.setNewsCache({
                date: newDate.getTime(),
                content: newHash,
                dismissed: false
            })
            ConfigManager.save()
        }

        const switchHandler = (forward) => {
            let cArt = parseInt(newsContent.getAttribute('article'))
            let nxtArt = forward ? (cArt >= newsArr.length-1 ? 0 : cArt + 1) : (cArt <= 0 ? newsArr.length-1 : cArt - 1)
    
            displayArticle(newsArr[nxtArt], nxtArt+1, forward ? 1 : -1)
        }

        const single = newsArr.length < 2
        document.getElementById('newsNavigationContainer').hidden = single
        document.getElementById('newsNavigateRight').onclick = () => { switchHandler(true) }
        document.getElementById('newsNavigateLeft').onclick = () => { switchHandler(false) }
        await fadeOutElement('#newsErrorContainer')
        displayArticle(newsArr[0], 1)
        await fadeInElement('#newsContent')
    }


}

/**
 * Add keyboard controls to the news UI. Left and right arrows toggle
 * between articles, Escape closes it. If you are on the landing page,
 * the up arrow will open the news UI.
 */
document.addEventListener('keydown', (e) => {
    if(newsActive){
        if((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && newsArr != null && newsArr.length > 1){
            document.getElementById(e.key === 'ArrowRight' ? 'newsNavigateRight' : 'newsNavigateLeft').click()
        } else if(e.key === 'Escape' && !document.getElementById('main').hasAttribute('overlay')){
            document.getElementById('newsButton').click()
        }
    } else {
        if(getCurrentView() === VIEWS.landing){
            if(e.key === 'ArrowUp'){
                document.getElementById('newsButton').click()
            }
        }
    }
})

/**
 * Write an article into the panel.
 *
 * @param {Object} articleObject The article meta object.
 */
function renderArticle(articleObject){
    const hasLink = /^https?:\/\//.test(articleObject.link)
    newsArticleTitle.textContent = articleObject.title
    newsArticleTitle.href = hasLink ? articleObject.link : '#'
    newsArticleLink.href = hasLink ? articleObject.link : '#'
    document.getElementById('newsFooter').hidden = !hasLink
    newsArticleDate.textContent = articleObject.date
    newsArticleDate.dateTime = articleObject.timestamp ? new Date(articleObject.timestamp).toISOString() : ''
    newsArticleAuthor.textContent = articleObject.author ? Lang.queryJS('landing.news.byAuthor', { author: articleObject.author }) : ''
    newsArticleContentScrollable.innerHTML = '<div id="newsArticleContentWrapper">' + articleObject.content + '</div>'
    newsArticleContentScrollable.scrollTop = 0
    newsContent.removeAttribute('scrolled')
    Array.from(newsArticleContentScrollable.getElementsByClassName('bbCodeSpoilerButton')).forEach(v => {
        v.onclick = () => {
            const text = v.parentElement.getElementsByClassName('bbCodeSpoilerText')[0]
            text.style.display = text.style.display === 'block' ? 'none' : 'block'
        }
    })
}

/**
 * Display a news article on the UI.
 * 
 * @param {Object} articleObject The article meta object.
 * @param {number} index The article index.
 * @param {number} direction 1 when moving forward, -1 backward, 0 for no transition.
 */
function displayArticle(articleObject, index, direction = 0){
    newsNavigationStatus.innerHTML = Lang.query('ejs.landing.newsNavigationStatus', {currentPage: index, totalPages: newsArr.length})
    newsContent.setAttribute('article', index-1)

    const parts = [newsHeading, newsArticleContentScrollable]
    gsap.killTweensOf(parts)
    if(direction === 0){
        gsap.set(parts, { clearProps: 'opacity,transform' })
        renderArticle(articleObject)
        return
    }
    gsap.timeline()
        .to(parts, { opacity: 0, x: -14 * direction, duration: 0.12, ease: 'power1.in' })
        .call(() => renderArticle(articleObject))
        .fromTo(parts, { x: 14 * direction }, { opacity: 1, x: 0, duration: 0.24, ease: 'power3.out', stagger: 0.04, clearProps: 'opacity,transform' })
}

/**
 * Load news information from the RSS feed specified in the
 * distribution index.
 */
async function loadNews(){

    const distroData = await DistroAPI.getDistribution()
    if(!distroData.rawDistribution.rss) {
        loggerLanding.debug('No RSS feed provided.')
        return null
    }

    const promise = new Promise((resolve, reject) => {
        
        const newsFeed = distroData.rawDistribution.rss
        const newsHost = new URL(newsFeed).origin + '/'
        $.ajax({
            url: newsFeed,
            dataType: 'xml',
            success: (data) => {
                const items = $(data).find('item')
                const articles = []

                for(let i=0; i<items.length; i++){
                // JQuery Element
                    const el = $(items[i])

                    const published = new Date(el.find('pubDate').text())
                    const timestamp = Number.isNaN(published.getTime()) ? null : published.getTime()
                    const date = timestamp == null ? '' : newsDateFormat.format(published)

                    const rawContent = el.find('content\\:encoded').text() || el.find('description').text()
                    const content = sanitizeNewsHTML(sanitizeNewsBrand(rawContent), newsHost)

                    const link   = el.find('link').text().trim()
                    const title  = sanitizeNewsBrand(el.find('title').text().trim())
                    const author = sanitizeNewsBrand(el.find('dc\\:creator').text().trim())

                    articles.push({
                        link,
                        title,
                        date,
                        timestamp,
                        author,
                        content
                    })
                }
                resolve({
                    articles
                })
            },
            timeout: 2500
        }).catch(err => {
            resolve({
                articles: null
            })
        })
    })

    return await promise
}
