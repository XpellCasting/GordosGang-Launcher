const AdmZip = require('adm-zip')
const fs = require('fs-extra')
const path = require('path')


function resolveInside(root, relativePath){
    if(typeof relativePath !== 'string' || relativePath.length === 0){
        throw new Error('Managed archive contains an empty path.')
    }
    const normalized = relativePath.replaceAll('\\', '/')
    const parts = normalized.split('/')
    if(normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || parts.some(part => part === '..' || part === '')){
        throw new Error(`Managed archive contains an unsafe path: ${relativePath}`)
    }
    const target = path.resolve(root, ...parts.filter(part => part !== '.'))
    const relation = path.relative(path.resolve(root), target)
    if(relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)){
        throw new Error(`Managed archive escapes its destination: ${relativePath}`)
    }
    return target
}

function assertNoSymlink(root, target){
    const relation = path.relative(path.resolve(root), path.resolve(target))
    let current = path.resolve(root)
    for(const part of relation.split(path.sep).filter(Boolean)){
        current = path.join(current, part)
        try {
            if(fs.lstatSync(current).isSymbolicLink()){
                throw new Error(`Managed archive path traverses a symbolic link: ${current}`)
            }
        } catch(error) {
            if(error.code !== 'ENOENT') throw error
        }
    }
}

function archiveEntries(archive){
    const entries = []
    const seen = new Set()
    for(const entry of archive.getEntries()){
        if(entry.isDirectory) continue
        const relativePath = entry.entryName.replaceAll('\\', '/')
        // A symlink inside a managed archive could redirect a later entry out
        // of the instance directory. Packs only need regular files here.
        const unixType = (entry.attr >>> 16) & 0xF000
        if(unixType === 0xA000){
            throw new Error(`Managed archive contains a symbolic link: ${relativePath}`)
        }
        resolveInside('.', relativePath)
        const key = relativePath.toLowerCase()
        if(seen.has(key)){
            throw new Error(`Managed archive contains a duplicate path: ${relativePath}`)
        }
        seen.add(key)
        entries.push({ entry, relativePath })
    }
    return entries
}

function readState(manifestPath){
    try {
        const state = fs.readJsonSync(manifestPath)
        if(typeof state.md5 !== 'string' || !Array.isArray(state.files)) return null
        return state
    } catch(_error) {
        return null
    }
}

function writeEntry(destination, item){
    const target = resolveInside(destination, item.relativePath)
    assertNoSymlink(destination, target)
    fs.ensureDirSync(path.dirname(target))
    const data = item.entry.getData()
    try {
        fs.writeFileSync(target, data)
    } catch(error) {
        // Windows refuses to recreate hidden files (Euphoria Patcher hides
        // config/euphoria_patcher/.data.json), so overwrite them in place.
        if(error.code !== 'EPERM' || !fs.pathExistsSync(target)) throw error
        const fd = fs.openSync(target, 'r+')
        try {
            fs.ftruncateSync(fd, 0)
            fs.writeSync(fd, data, 0, data.length, 0)
        } finally {
            fs.closeSync(fd)
        }
    }
}

/**
 * Apply verified archives downloaded by FullRepair.
 *
 * An unchanged archive only restores missing managed files, preserving player
 * edits. A changed archive overwrites its managed files and removes paths that
 * were managed by the previous version but are no longer shipped.
 */
function applyManagedArchives(server, gameDir){
    const results = []
    for(const module of server.modules){
        const extraction = module.rawModule.extract
        if(extraction == null) continue
        if(extraction.format !== 'zip'){
            throw new Error(`Unsupported managed archive format: ${extraction.format}`)
        }
        const destination = resolveInside(gameDir, extraction.destination ?? '.')
        const manifestPath = resolveInside(gameDir, extraction.manifest)
        assertNoSymlink(gameDir, destination)
        assertNoSymlink(gameDir, manifestPath)
        fs.ensureDirSync(destination)

        const archive = new AdmZip(module.getPath())
        const entries = archiveEntries(archive)
        const state = readState(manifestPath)
        const expectedMD5 = module.rawModule.artifact.MD5.toLowerCase()
        const unchanged = state?.md5?.toLowerCase() === expectedMD5

        if(unchanged){
            const missing = entries.filter(item => {
                const target = resolveInside(destination, item.relativePath)
                assertNoSymlink(destination, target)
                return !fs.pathExistsSync(target)
            })
            missing.forEach(item => writeEntry(destination, item))
            results.push({ id: module.rawModule.id, extracted: missing.length, updated: false })
            continue
        }

        const currentFiles = new Set(entries.map(item => item.relativePath.toLowerCase()))
        for(const oldPath of state?.files ?? []){
            if(typeof oldPath !== 'string' || currentFiles.has(oldPath.toLowerCase())) continue
            const target = resolveInside(destination, oldPath)
            assertNoSymlink(destination, target)
            fs.removeSync(target)
        }
        entries.forEach(item => writeEntry(destination, item))
        fs.ensureDirSync(path.dirname(manifestPath))
        fs.writeJsonSync(manifestPath, {
            md5: expectedMD5,
            files: entries.map(item => item.relativePath)
        }, { spaces: 2 })
        results.push({ id: module.rawModule.id, extracted: entries.length, updated: true })
    }
    return results
}


module.exports = { applyManagedArchives, resolveInside }
