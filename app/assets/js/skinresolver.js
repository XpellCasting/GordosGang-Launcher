/**
 * Resolve skin render URLs for an account.
 *
 * mc-heads caches renders per UUID and can keep serving the default skin long
 * after a player changes theirs. Rendering by the skin's texture hash, read
 * from Mojang's session server, always reflects the skin the account has now.
 */
const MC_HEADS = 'https://mc-heads.net'

const textureIds = new Map()

function textureId(uuid){
    const id = String(uuid).replace(/-/g, '')
    if(!textureIds.has(id)){
        const lookup = fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`)
            .then(res => res.ok ? res.json() : null)
            .then(profile => {
                const textures = profile?.properties?.find(p => p.name === 'textures')
                if(textures == null){
                    return id
                }
                const skinURL = JSON.parse(atob(textures.value)).textures?.SKIN?.url
                return skinURL?.split('/').pop() || id
            })
            .catch(() => {
                // Retry on the next render instead of pinning a failed lookup.
                textureIds.delete(id)
                return id
            })
        textureIds.set(id, lookup)
    }
    return textureIds.get(id)
}

/**
 * @param {string} uuid Account UUID, dashed or not.
 * @param {'head' | 'body'} view Render type.
 * @param {string | number} variant Size in pixels, or an mc-heads option such as 'right'.
 * @returns {Promise<string>} The render URL.
 */
exports.renderURL = async function(uuid, view, variant){
    return `${MC_HEADS}/${view}/${await textureId(uuid)}/${variant}`
}

/**
 * Fill every `img[data-skin-uuid]` under root with its resolved render.
 * Optional `data-skin-view` (default 'head') and `data-skin-variant`.
 *
 * @param {ParentNode} root
 */
exports.applyTo = function(root){
    for(const img of root.querySelectorAll('img[data-skin-uuid]')){
        const { skinUuid, skinView = 'head', skinVariant = '' } = img.dataset
        exports.renderURL(skinUuid, skinView, skinVariant).then(url => {
            if(img.dataset.skinUuid === skinUuid){
                img.src = url
            }
        })
    }
}
