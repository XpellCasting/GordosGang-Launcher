/**
 * Initialize UI functions which depend on internal modules.
 * Loaded after core UI functions are initialized in uicore.js.
 */
// Requirements
const path          = require('path')
const { Type }      = require('helios-distribution-types')

const AuthManager   = require('./assets/js/authmanager')
const ConfigManager = require('./assets/js/configmanager')
const { DistroAPI } = require('./assets/js/distromanager')
const SkinResolver  = require('./assets/js/skinresolver')

let rscShouldLoad = false
let fatalStartupError = false

// Mapping of each view to their container IDs.
const VIEWS = {
    landing: '#landingContainer',
    loginOptions: '#loginOptionsContainer',
    login: '#loginContainer',
    settings: '#settingsContainer',
    waiting: '#waitingContainer'
}

// The currently shown view container.
let currentView

/**
 * Switch launcher views.
 * 
 * @param {string} current The ID of the current view container. 
 * @param {*} next The ID of the next view container.
 * @param {*} currentFadeTime Optional. The fade out time for the current view.
 * @param {*} nextFadeTime Optional. The fade in time for the next view.
 * @param {*} onCurrentFade Optional. Callback function to execute when the current
 * view fades out.
 * @param {*} onNextFade Optional. Callback function to execute when the next view
 * fades in.
 */
/**
 * Reveal a view with a single compositor-friendly fade. Keeping this to one
 * layer avoids the staggered transforms that made navigation feel delayed.
 */
function revealView(view, duration){
    return gsap.fromTo(view,
        { opacity: 0 },
        { opacity: 1, duration: Math.min(duration, 0.18), ease: 'power2.out' }
    )
}

function switchView(current, next, currentFadeTime = 500, nextFadeTime = 500, onCurrentFade = () => {}, onNextFade = () => {}){
    currentView = next

    // Durations stay in the caller's milliseconds so existing call sites keep
    // their tuning, and the contract is unchanged: the outgoing view is hidden
    // and onCurrentFade has resolved before the incoming view appears.
    gsap.to(current, {
        opacity: 0,
        duration: Math.min(currentFadeTime / 1000, 0.14),
        ease: 'power2.in',
        onComplete: async () => {
            $(current).hide()
            await onCurrentFade()

            // jQuery resolves the container's intended display value (flex vs
            // block) that the inline display:none hides.
            $(next).css('opacity', 0).show()
            gsap.timeline({
                onComplete: async () => {
                    await onNextFade()
                }
            }).add(revealView(next, nextFadeTime / 1000))
        }
    })
}

/**
 * Get the currently shown view container.
 * 
 * @returns {string} The currently shown view container.
 */
function getCurrentView(){
    return currentView
}

/* ---------------------------------------------------------------------------
 * Startup loading screen.
 *
 * Progress represents completed startup stages, not download bytes, so only a
 * handful of values ever report in. The raw number is tweened rather than
 * written straight to the DOM, otherwise the logo fill snaps between stages.
 * ------------------------------------------------------------------------- */

const startupProgress = { value: 0 }

function renderStartupProgress(){
    const track = document.getElementById('startupLoadingTrack')
    if(track == null){
        return
    }
    track.style.setProperty('--startup-progress', `${startupProgress.value}%`)
    track.setAttribute('aria-valuenow', Math.round(startupProgress.value))
}

/**
 * Name the stage the launcher is actually in. Silence during a multi-second
 * startup is what makes it read as hung.
 */
function setStartupStatus(key){
    const el = document.getElementById('startupLoadingStatus')
    if(el == null){
        return
    }
    const text = Lang.queryJS(`uibinder.startup.${key}`)
    if(el.textContent === text){
        return
    }
    el.textContent = text
}

function setStartupProgress(percent){
    return gsap.to(startupProgress, {
        value: percent,
        duration: 0.28,
        ease: 'power2.out',
        overwrite: true,
        onUpdate: renderStartupProgress
    })
}

/**
 * Bring the loading logo in without running a permanent animation.
 */
function initStartupLoading(){
    renderStartupProgress()

    const status = document.getElementById('startupLoadingStatus')
    status.textContent = Lang.queryJS('uibinder.startup.stageConnecting')

    gsap.from('#loadingContent', { opacity: 0, duration: 0.22, ease: 'power2.out' })
}

/**
 * Tear the loading screen down. Returns the timeline so callers can hang their
 * own steps off the handoff.
 */
function dismissStartupLoading(){
    const tl = gsap.timeline()

    // Stop swallowing clicks the moment the screen starts leaving.
    tl.set('#loadingContainer', { pointerEvents: 'none' })
        .to('#loadingContent', { opacity: 0, duration: 0.18, ease: 'power2.out' })

    return tl
}

async function showMainUI(data){

    setStartupProgress(65)

    if(!isDev){
        loggerAutoUpdater.info('Initializing..')
        ipcRenderer.send('autoUpdateAction', 'initAutoUpdater', ConfigManager.getAllowPrerelease())
    }

    setStartupStatus('stagePreparing')
    await prepareSettings(true)
    setStartupProgress(85)
    updateSelectedServer(resolveSelectedServer(data))
    refreshServerStatus()

    const isLoggedIn = Object.keys(ConfigManager.getAuthAccounts()).length > 0

    let nextView
    if(isLoggedIn){
        nextView = VIEWS.landing
    } else {
        loginOptionsCancelEnabled(false)
        loginOptionsViewOnLoginSuccess = VIEWS.landing
        loginOptionsViewOnLoginCancel = VIEWS.loginOptions
        nextView = VIEWS.loginOptions
    }
    currentView = nextView

    // Stage the destination view behind the loading screen so the two can be
    // cross-faded. jQuery resolves the container's intended display value
    // (flex vs block); GSAP only ever touches opacity.
    $('#main').show()
    $(nextView).css('opacity', 0).show()

    // If this is enabled in a development environment we'll get ratelimited.
    // The relaunch frequency is usually far too high.
    if(!isDev && isLoggedIn){
        validateSelectedAccount()
    }

    setStartupStatus('stageReady')

    gsap.timeline()
        // Drive the fill to the end of the logo before anything else moves.
        .to(startupProgress, {
            value: 100,
            duration: 0.25,
            ease: 'power2.out',
            overwrite: true,
            onUpdate: renderStartupProgress
        })
        .add(dismissStartupLoading())
        .add(revealView(nextView, 0.18), '<0.08')
        .set('#loadingContainer', { display: 'none' })

    // Disable tabbing to the news container.
    initNews().then(() => {
        $('#newsContainer *').attr('tabindex', '-1')
    })
}

/**
 * Resolve the saved server, falling back to the distribution's main server.
 *
 * Pack migrations deliberately use a new server id so Forge/Fabric files from
 * the old instance can never be mixed. Existing installations still have the
 * previous id saved, so treating that as "no selection" would disable Play.
 */
function resolveSelectedServer(data){
    return data.getServerById(ConfigManager.getSelectedServer())
        ?? data.servers.find(server => server.rawServer.mainServer)
        ?? data.servers[0]
        ?? null
}

function showFatalStartupError(){
    dismissStartupLoading()
        .set('#loadingContainer', { display: 'none' })
        .call(() => {
            document.getElementById('overlayContainer').style.background = 'none'
            setOverlayContent(
                Lang.queryJS('uibinder.startup.fatalErrorTitle'),
                Lang.queryJS('uibinder.startup.fatalErrorMessage'),
                Lang.queryJS('uibinder.startup.closeButton')
            )
            setOverlayHandler(() => {
                const window = remote.getCurrentWindow()
                window.close()
            })
            toggleOverlay(true)
        })
}

/**
 * Common functions to perform after refreshing the distro index.
 * 
 * @param {Object} data The distro index object.
 */
function onDistroRefresh(data){
    updateSelectedServer(resolveSelectedServer(data))
    refreshServerStatus()
    initNews()
    syncModConfigurations(data)
    ensureJavaSettings(data)
}

/**
 * Sync the mod configurations with the distro index.
 * 
 * @param {Object} data The distro index object.
 */
function syncModConfigurations(data){

    const syncedCfgs = []

    for(let serv of data.servers){

        const id = serv.rawServer.id
        const mdls = serv.modules
        const cfg = ConfigManager.getModConfiguration(id)

        if(cfg != null){

            const modsOld = cfg.mods
            const mods = {}

            for(let mdl of mdls){
                const type = mdl.rawModule.type

                if(type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod){
                    if(!mdl.getRequired().value){
                        const mdlID = mdl.getVersionlessMavenIdentifier()
                        if(modsOld[mdlID] == null){
                            mods[mdlID] = scanOptionalSubModules(mdl.subModules, mdl)
                        } else {
                            mods[mdlID] = mergeModConfiguration(modsOld[mdlID], scanOptionalSubModules(mdl.subModules, mdl), false)
                        }
                    } else {
                        if(mdl.subModules.length > 0){
                            const mdlID = mdl.getVersionlessMavenIdentifier()
                            const v = scanOptionalSubModules(mdl.subModules, mdl)
                            if(typeof v === 'object'){
                                if(modsOld[mdlID] == null){
                                    mods[mdlID] = v
                                } else {
                                    mods[mdlID] = mergeModConfiguration(modsOld[mdlID], v, true)
                                }
                            }
                        }
                    }
                }
            }

            syncedCfgs.push({
                id,
                mods
            })

        } else {

            const mods = {}

            for(let mdl of mdls){
                const type = mdl.rawModule.type
                if(type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod){
                    if(!mdl.getRequired().value){
                        mods[mdl.getVersionlessMavenIdentifier()] = scanOptionalSubModules(mdl.subModules, mdl)
                    } else {
                        if(mdl.subModules.length > 0){
                            const v = scanOptionalSubModules(mdl.subModules, mdl)
                            if(typeof v === 'object'){
                                mods[mdl.getVersionlessMavenIdentifier()] = v
                            }
                        }
                    }
                }
            }

            syncedCfgs.push({
                id,
                mods
            })

        }
    }

    ConfigManager.setModConfigurations(syncedCfgs)
    ConfigManager.save()
}

/**
 * Ensure java configurations are present for the available servers.
 * 
 * @param {Object} data The distro index object.
 */
function ensureJavaSettings(data) {

    // Nothing too fancy for now.
    for(const serv of data.servers){
        ConfigManager.ensureJavaConfig(serv.rawServer.id, serv.effectiveJavaOptions, serv.rawServer.javaOptions?.ram)
    }

    ConfigManager.save()
}

/**
 * Recursively scan for optional sub modules. If none are found,
 * this function returns a boolean. If optional sub modules do exist,
 * a recursive configuration object is returned.
 * 
 * @returns {boolean | Object} The resolved mod configuration.
 */
function scanOptionalSubModules(mdls, origin){
    if(mdls != null){
        const mods = {}

        for(let mdl of mdls){
            const type = mdl.rawModule.type
            // Optional types.
            if(type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod){
                // It is optional.
                if(!mdl.getRequired().value){
                    mods[mdl.getVersionlessMavenIdentifier()] = scanOptionalSubModules(mdl.subModules, mdl)
                } else {
                    if(mdl.hasSubModules()){
                        const v = scanOptionalSubModules(mdl.subModules, mdl)
                        if(typeof v === 'object'){
                            mods[mdl.getVersionlessMavenIdentifier()] = v
                        }
                    }
                }
            }
        }

        if(Object.keys(mods).length > 0){
            const ret = {
                mods
            }
            if(!origin.getRequired().value){
                ret.value = origin.getRequired().def
            }
            return ret
        }
    }
    return origin.getRequired().def
}

/**
 * Recursively merge an old configuration into a new configuration.
 * 
 * @param {boolean | Object} o The old configuration value.
 * @param {boolean | Object} n The new configuration value.
 * @param {boolean} nReq If the new value is a required mod.
 * 
 * @returns {boolean | Object} The merged configuration.
 */
function mergeModConfiguration(o, n, nReq = false){
    if(typeof o === 'boolean'){
        if(typeof n === 'boolean') return o
        else if(typeof n === 'object'){
            if(!nReq){
                n.value = o
            }
            return n
        }
    } else if(typeof o === 'object'){
        if(typeof n === 'boolean') return typeof o.value !== 'undefined' ? o.value : true
        else if(typeof n === 'object'){
            if(!nReq){
                n.value = typeof o.value !== 'undefined' ? o.value : true
            }

            const newMods = Object.keys(n.mods)
            for(let i=0; i<newMods.length; i++){

                const mod = newMods[i]
                if(o.mods[mod] != null){
                    n.mods[mod] = mergeModConfiguration(o.mods[mod], n.mods[mod])
                }
            }

            return n
        }
    }
    // If for some reason we haven't been able to merge,
    // wipe the old value and use the new one. Just to be safe
    return n
}

async function validateSelectedAccount(){
    const selectedAcc = ConfigManager.getSelectedAccount()
    if(selectedAcc != null){
        const val = await AuthManager.validateSelected()
        if(!val){
            ConfigManager.removeAuthAccount(selectedAcc.uuid)
            ConfigManager.save()
            const accLen = Object.keys(ConfigManager.getAuthAccounts()).length
            setOverlayContent(
                Lang.queryJS('uibinder.validateAccount.failedMessageTitle'),
                accLen > 0
                    ? Lang.queryJS('uibinder.validateAccount.failedMessage', { 'account': selectedAcc.displayName })
                    : Lang.queryJS('uibinder.validateAccount.failedMessageSelectAnotherAccount', { 'account': selectedAcc.displayName }),
                Lang.queryJS('uibinder.validateAccount.loginButton'),
                Lang.queryJS('uibinder.validateAccount.selectAnotherAccountButton')
            )
            setOverlayHandler(() => {

                const isMicrosoft = selectedAcc.type === 'microsoft'

                if(isMicrosoft) {
                    // Empty for now
                } else {
                    // Mojang
                    // For convenience, pre-populate the username of the account.
                    document.getElementById('loginUsername').value = selectedAcc.username
                    validateEmail(selectedAcc.username)
                }
                
                loginOptionsViewOnLoginSuccess = getCurrentView()
                loginOptionsViewOnLoginCancel = VIEWS.loginOptions

                if(accLen > 0) {
                    loginOptionsViewOnCancel = getCurrentView()
                    loginOptionsViewCancelHandler = () => {
                        if(isMicrosoft) {
                            ConfigManager.addMicrosoftAuthAccount(
                                selectedAcc.uuid,
                                selectedAcc.accessToken,
                                selectedAcc.username,
                                selectedAcc.expiresAt,
                                selectedAcc.microsoft.access_token,
                                selectedAcc.microsoft.refresh_token,
                                selectedAcc.microsoft.expires_at
                            )
                        } else {
                            ConfigManager.addMojangAuthAccount(selectedAcc.uuid, selectedAcc.accessToken, selectedAcc.username, selectedAcc.displayName)
                        }
                        ConfigManager.save()
                        validateSelectedAccount()
                    }
                    loginOptionsCancelEnabled(true)
                } else {
                    loginOptionsCancelEnabled(false)
                }
                toggleOverlay(false)
                switchView(getCurrentView(), VIEWS.loginOptions)
            })
            setDismissHandler(() => {
                if(accLen > 1){
                    prepareAccountSelectionList()
                    fadeOutElement('#overlayContent').then(() => {
                        bindOverlayKeys(true, 'accountSelectContent', true)
                        return fadeInElement('#accountSelectContent')
                    })
                } else {
                    const accountsObj = ConfigManager.getAuthAccounts()
                    const accounts = Array.from(Object.keys(accountsObj), v => accountsObj[v])
                    // This function validates the account switch.
                    setSelectedAccount(accounts[0].uuid)
                    toggleOverlay(false)
                }
            })
            toggleOverlay(true, accLen > 0)
        } else {
            return true
        }
    } else {
        return true
    }
}

/**
 * Temporary function to update the selected account along
 * with the relevent UI elements.
 * 
 * @param {string} uuid The UUID of the account.
 */
function setSelectedAccount(uuid){
    const authAcc = ConfigManager.setSelectedAccount(uuid)
    ConfigManager.save()
    updateSelectedAccount(authAcc)
    validateSelectedAccount()
}

document.addEventListener('DOMContentLoaded', initStartupLoading, { once: true })

// Synchronous Listener
document.addEventListener('readystatechange', async () => {

    if (document.readyState === 'interactive' || document.readyState === 'complete'){
        if(rscShouldLoad){
            rscShouldLoad = false
            if(!fatalStartupError){
                const data = await DistroAPI.getDistribution()
                await showMainUI(data)
            } else {
                showFatalStartupError()
            }
        } 
    }

}, false)

// Actions that must be performed after the distribution index is downloaded.
ipcRenderer.on('distributionIndexDone', async (event, res) => {
    if(res) {
        const data = await DistroAPI.getDistribution()
        syncModConfigurations(data)
        ensureJavaSettings(data)
        if(document.readyState === 'interactive' || document.readyState === 'complete'){
            await showMainUI(data)
        } else {
            rscShouldLoad = true
        }
    } else {
        fatalStartupError = true
        if(document.readyState === 'interactive' || document.readyState === 'complete'){
            showFatalStartupError()
        } else {
            rscShouldLoad = true
        }
    }
})

// Util for development
async function devModeToggle() {
    DistroAPI.toggleDevMode(true)
    const data = await DistroAPI.refreshDistributionOrFallback()
    ensureJavaSettings(data)
    updateSelectedServer(data.servers[0])
    syncModConfigurations(data)
}
