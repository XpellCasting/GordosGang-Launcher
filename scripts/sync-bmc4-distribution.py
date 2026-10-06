#!/usr/bin/env python3
"""Build a Helios distribution from the official Better MC 4 CurseForge pack.

CurseForge artifacts keep their CDN URLs. Only the pack overrides, generated
Forge client libraries, news, and artwork are written to the public directory.
The destination is replaced atomically after the complete distribution has
been generated and validated.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime
from email.utils import format_datetime
from pathlib import Path, PurePosixPath
from xml.sax.saxutils import escape as xml_escape


USER_AGENT = "GordosGang-Launcher/1.1"
DEFAULT_CURSE_API = "https://api.curse.tools/v1"
DEFAULT_NEWS_FILE = Path(__file__).with_name("bmc4-news.json")
CURSE_CLASS_MODS = 6
CURSE_CLASS_RESOURCE_PACKS = 12
CURSE_CLASS_SHADERS = 6552
CURSE_CLASS_DATA_PACKS = 6945
MUTABLE_ROOT_OVERRIDES = {"options.txt", "servers.dat"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--client-pack", required=True, type=Path)
    parser.add_argument("--public-dir", required=True, type=Path)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--server-address", required=True)
    parser.add_argument("--icon", required=True, type=Path)
    parser.add_argument("--news", type=Path, default=DEFAULT_NEWS_FILE)
    parser.add_argument(
        "--extra-pack",
        type=Path,
        help="optional Arclight client extras zip (mandatory mods/config only)",
    )
    parser.add_argument(
        "--exclude-curse-file",
        action="append",
        default=[],
        help="CurseForge filename replaced by the extra pack; may be repeated",
    )
    parser.add_argument("--java", default="java", help="Java 17+ executable used by Forge's installer")
    parser.add_argument("--forge-installer", type=Path, help="optional pre-downloaded Forge installer")
    parser.add_argument("--curse-api-base", default=DEFAULT_CURSE_API)
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--server-id", default="Better-MC-1.20.1")
    parser.add_argument("--server-name", default="Better MC")
    parser.add_argument("--minimum-ram", type=int, default=6144)
    parser.add_argument("--recommended-ram", type=int, default=10240)
    args = parser.parse_args()
    if args.workers < 1:
        parser.error("--workers must be positive")
    for field in ("minimum_ram", "recommended_ram"):
        if getattr(args, field) <= 0 or getattr(args, field) % 512:
            parser.error(f"--{field.replace('_', '-')} must be a positive multiple of 512")
    if args.recommended_ram < args.minimum_ram:
        parser.error("--recommended-ram cannot be lower than --minimum-ram")
    return args


def safe_relative_path(value: str) -> PurePosixPath:
    path = PurePosixPath(value.replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"Unsafe relative path: {value}")
    return path


def slug(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9._-]+", "-", value.lower()).strip("-.")
    return cleaned[:64] or "artifact"


def file_hash(path: Path, algorithm: str) -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def artifact(path: Path, url: str, relative_path: str | None = None) -> dict:
    result = {"size": path.stat().st_size, "MD5": file_hash(path, "md5"), "url": url}
    if relative_path is not None:
        result["path"] = relative_path
    return result


def encoded_url(base_url: str, *parts: str) -> str:
    encoded = "/".join(
        urllib.parse.quote(part, safe="")
        for value in parts
        for part in PurePosixPath(value).parts
    )
    return f"{base_url.rstrip('/')}/{encoded}"


def request_json(url: str, api_key: str | None = None) -> dict:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if api_key:
        headers["x-api-key"] = api_key
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=60) as response:
                value = json.load(response)
            return value.get("data", value)
        except (OSError, urllib.error.HTTPError, json.JSONDecodeError) as error:
            last_error = error
            if attempt == 3:
                break
            time.sleep(1.5 * (2**attempt))
    raise RuntimeError(f"Unable to read {url}: {last_error}")


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response, destination.open("wb") as output:
        shutil.copyfileobj(response, output, length=1024 * 1024)


def md5_from_curse_file(file_data: dict) -> str:
    for entry in file_data.get("hashes", []):
        if entry.get("algo") == 2:
            return entry["value"].lower()
    raise ValueError(f"CurseForge file {file_data.get('id')} does not declare an MD5")


def resolve_curse_file(entry: dict, api_base: str, api_key: str | None) -> dict:
    project_id = int(entry["projectID"])
    file_id = int(entry["fileID"])
    file_data = request_json(
        f"{api_base.rstrip('/')}/mods/{project_id}/files/{file_id}", api_key
    )
    if int(file_data.get("id", -1)) != file_id or int(file_data.get("modId", -1)) != project_id:
        raise ValueError(f"CurseForge returned the wrong file for {project_id}:{file_id}")
    if not file_data.get("isAvailable", True):
        raise ValueError(f"CurseForge file {project_id}:{file_id} is unavailable")
    filename = file_data.get("fileName")
    if not isinstance(filename, str) or PurePosixPath(filename).name != filename:
        raise ValueError(f"Unsafe CurseForge filename for {project_id}:{file_id}: {filename!r}")
    class_id = CURSE_CLASS_MODS
    website_url = ""
    if not filename.lower().endswith(".jar"):
        project_data = request_json(f"{api_base.rstrip('/')}/mods/{project_id}", api_key)
        class_id = int(project_data.get("classId", -1))
        website_url = project_data.get("links", {}).get("websiteUrl") or ""
    download_url = file_data.get("downloadUrl")
    if not download_url:
        download_url = request_json(
            f"{api_base.rstrip('/')}/mods/{project_id}/files/{file_id}/download-url",
            api_key,
        )
    if not isinstance(download_url, str) or not download_url.startswith("https://"):
        raise ValueError(f"CurseForge file {project_id}:{file_id} has no HTTPS download URL")
    return {
        "project_id": project_id,
        "file_id": file_id,
        "required": bool(entry.get("required", True)),
        "filename": filename,
        "size": int(file_data["fileLength"]),
        "md5": md5_from_curse_file(file_data),
        "url": download_url,
        "class_id": class_id,
        "website_url": website_url,
    }


def build_curse_modules(
    manifest: dict,
    api_base: str,
    workers: int,
    excluded_names: set[str],
) -> tuple[list[dict], set[str]]:
    api_key = os.environ.get("CURSEFORGE_API_KEY")
    entries = manifest.get("files", [])
    print(f"Resolving {len(entries)} CurseForge artifacts...", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        resolved = list(
            executor.map(
                lambda entry: resolve_curse_file(entry, api_base, api_key),
                entries,
            )
        )

    modules: list[dict] = []
    instance_targets: set[str] = set()
    pack_version = slug(manifest["version"])
    for item in resolved:
        filename = item["filename"]
        if filename.casefold() in excluded_names:
            print(f"  replacing CurseForge artifact {filename}", flush=True)
            continue
        module = {
            "id": (
                f"gg.bmc4.cf:project-{item['project_id']}:"
                f"{pack_version}-file-{item['file_id']}"
            ),
            "name": filename,
            "type": "File",
            "artifact": {
                "size": item["size"],
                "MD5": item["md5"],
                "url": item["url"],
            },
        }
        if filename.lower().endswith(".jar"):
            if item["class_id"] != CURSE_CLASS_MODS:
                raise ValueError(f"Unexpected non-mod jar in CurseForge manifest: {filename}")
            destination = f"mods/{filename}"
            module["artifact"]["path"] = destination
        else:
            website = item["website_url"].lower()
            if item["class_id"] == CURSE_CLASS_SHADERS or "/shaders/" in website:
                destination = f"shaderpacks/{filename}"
            elif item["class_id"] == CURSE_CLASS_RESOURCE_PACKS or "/texture-packs/" in website:
                destination = f"resourcepacks/{filename}"
            elif item["class_id"] == CURSE_CLASS_DATA_PACKS or "/data-packs/" in website:
                destination = f"datapacks/{filename}"
            else:
                raise ValueError(
                    f"Unsupported CurseForge project class {item['class_id']} for {filename}"
                )
            module["artifact"]["path"] = destination
        if destination.casefold() in instance_targets:
            raise ValueError(f"Duplicate instance target: {destination}")
        instance_targets.add(destination.casefold())
        if not item["required"]:
            module["required"] = {"value": False, "def": False}
        modules.append(module)
    return modules, instance_targets


def add_override_bundle(
    archive: zipfile.ZipFile,
    manifest: dict,
    public_root: Path,
    base_url: str,
    occupied_targets: set[str],
    extra_pack: Path | None,
    official_mod_names: set[str],
) -> tuple[dict, int, int]:
    prefix = manifest.get("overrides", "overrides").strip("/") + "/"
    pack_version = slug(manifest["version"])
    bundle_name = f"bmc4-overrides-{pack_version}.zip"
    public_path = public_root / "bundles" / bundle_name
    public_path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    extra_count = 0
    extra_entries: list[tuple[zipfile.ZipFile, zipfile.ZipInfo, PurePosixPath]] = []
    extra_archive = zipfile.ZipFile(extra_pack) if extra_pack else None
    if extra_archive:
        for info in sorted(extra_archive.infolist(), key=lambda item: item.filename.casefold()):
            if info.is_dir():
                continue
            source_path = safe_relative_path(info.filename)
            if source_path.parts[0] == "mods-opcionales" or source_path.name == "LEEME.txt":
                continue
            if source_path.parts[0] not in {"mods", "config"}:
                raise ValueError(f"Unsupported path in extra client pack: {source_path}")
            if source_path.parts[0] == "mods":
                if len(source_path.parts) != 2 or source_path.suffix.casefold() != ".jar":
                    raise ValueError(f"Invalid mandatory mod in extra client pack: {source_path}")
                if source_path.name.casefold() in official_mod_names:
                    print(f"  skipping exact duplicate extra mod {source_path.name}", flush=True)
                    continue
            extra_entries.append((extra_archive, info, source_path))
    extra_targets = {relative.as_posix().casefold() for _, _, relative in extra_entries}
    with zipfile.ZipFile(
        public_path,
        "w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
    ) as bundle:
        for info in sorted(archive.infolist(), key=lambda item: item.filename.casefold()):
            if info.is_dir() or not info.filename.startswith(prefix):
                continue
            relative = safe_relative_path(info.filename[len(prefix) :])
            if len(relative.parts) == 1 and relative.name.casefold() in MUTABLE_ROOT_OVERRIDES:
                print(f"  preserving player-owned {relative}", flush=True)
                continue
            target_key = relative.as_posix().casefold()
            if target_key in extra_targets:
                print(f"  replacing official override {relative}", flush=True)
                continue
            if target_key in occupied_targets:
                raise ValueError(f"Pack override collides with another artifact: {relative}")
            occupied_targets.add(target_key)
            bundled_info = zipfile.ZipInfo(relative.as_posix(), date_time=info.date_time)
            bundled_info.compress_type = zipfile.ZIP_DEFLATED
            bundled_info.external_attr = 0o100644 << 16
            with archive.open(info) as source, bundle.open(
                bundled_info, "w", force_zip64=True
            ) as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
            count += 1
        for extra_source, info, relative in extra_entries:
            target_key = relative.as_posix().casefold()
            if target_key in occupied_targets:
                raise ValueError(f"Extra client file collides with another artifact: {relative}")
            occupied_targets.add(target_key)
            bundled_info = zipfile.ZipInfo(relative.as_posix(), date_time=info.date_time)
            bundled_info.compress_type = zipfile.ZIP_DEFLATED
            bundled_info.external_attr = 0o100644 << 16
            with extra_source.open(info) as source, bundle.open(
                bundled_info, "w", force_zip64=True
            ) as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
            count += 1
            extra_count += 1
    if extra_archive:
        extra_archive.close()
    print(
        f"Bundled {count} managed files ({extra_count} Arclight extras) into {bundle_name}",
        flush=True,
    )
    return (
        {
            "id": f"gg.bmc4:override-bundle:{pack_version}",
            "name": f"Better MC overrides {manifest['version']}",
            "type": "File",
            "artifact": artifact(
                public_path,
                encoded_url(base_url, "bundles", bundle_name),
                ".launcher/cache/bmc4-overrides.zip",
            ),
            "extract": {
                "format": "zip",
                "destination": ".",
                "manifest": ".launcher/managed-bmc4-overrides.json",
            },
        },
        count,
        extra_count,
    )


def coordinate_path(identifier: str) -> PurePosixPath:
    extension = "jar"
    coordinate = identifier
    if "@" in coordinate:
        coordinate, extension = coordinate.rsplit("@", 1)
    parts = coordinate.split(":")
    if len(parts) not in (3, 4):
        raise ValueError(f"Unsupported Maven coordinate: {identifier}")
    group, name, version = parts[:3]
    classifier = f"-{parts[3]}" if len(parts) == 4 else ""
    return PurePosixPath(
        group.replace(".", "/"),
        name,
        version,
        f"{name}-{version}{classifier}.{extension}",
    )


def local_library(root: Path, identifier: str) -> Path:
    return root / Path(*coordinate_path(identifier).parts)


def library_module(
    identifier: str,
    path: Path,
    url: str,
    *,
    classpath: bool | None = None,
) -> dict:
    if not path.is_file():
        raise FileNotFoundError(f"Forge installation did not produce {path}")
    module = {
        "id": identifier,
        "name": identifier,
        "type": "Library",
        "artifact": artifact(path, url),
    }
    if classpath is not None:
        module["classpath"] = classpath
    return module


def build_forge_module(
    public_root: Path,
    base_url: str,
    minecraft_version: str,
    forge_version: str,
    java: str,
    supplied_installer: Path | None,
) -> dict:
    profile_id = f"{minecraft_version}-forge-{forge_version}"
    installer_name = f"forge-{minecraft_version}-{forge_version}-installer.jar"
    installer_url = (
        "https://maven.minecraftforge.net/net/minecraftforge/forge/"
        f"{minecraft_version}-{forge_version}/{installer_name}"
    )
    with tempfile.TemporaryDirectory(prefix="gordosgang-forge-") as temporary:
        root = Path(temporary)
        installer = root / installer_name
        if supplied_installer is None:
            print(f"Downloading Forge {forge_version} installer...", flush=True)
            download(installer_url, installer)
        else:
            shutil.copy2(supplied_installer, installer)
        (root / "launcher_profiles.json").write_text(
            json.dumps(
                {
                    "profiles": {},
                    "selectedProfile": None,
                    "clientToken": "00000000-0000-0000-0000-000000000000",
                    "authenticationDatabase": {},
                }
            ),
            encoding="utf-8",
        )
        print("Preparing Forge client libraries...", flush=True)
        result = subprocess.run(
            [java, "-jar", str(installer), "--installClient", str(root)],
            cwd=root,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            check=False,
        )
        if result.returncode:
            tail = "\n".join(result.stdout.splitlines()[-80:])
            raise RuntimeError(f"Forge installer failed with code {result.returncode}:\n{tail}")

        libraries_root = root / "libraries"
        profile_path = root / "versions" / profile_id / f"{profile_id}.json"
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
        if profile.get("inheritsFrom") != minecraft_version:
            raise ValueError(f"Forge profile inherits from {profile.get('inheritsFrom')}, expected {minecraft_version}")

        public_profile = public_root / "forge" / "versions" / f"{profile_id}.json"
        public_profile.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(profile_path, public_profile)
        submodules = [
            {
                "id": profile_id,
                "name": "Forge client profile",
                "type": "VersionManifest",
                "artifact": artifact(
                    public_profile,
                    encoded_url(base_url, "forge", "versions", f"{profile_id}.json"),
                ),
            }
        ]

        forge_coordinate_version = f"{minecraft_version}-{forge_version}"
        external_support = [
            (f"net.minecraftforge:fmlcore:{forge_coordinate_version}", True),
            (f"net.minecraftforge:javafmllanguage:{forge_coordinate_version}", True),
            (f"net.minecraftforge:mclanguage:{forge_coordinate_version}", True),
            (f"net.minecraftforge:forge:{forge_coordinate_version}:universal", False),
        ]
        for identifier, classpath in external_support:
            relative = coordinate_path(identifier)
            local_path = libraries_root / Path(*relative.parts)
            submodules.append(
                library_module(
                    identifier,
                    local_path,
                    f"https://maven.minecraftforge.net/{relative.as_posix()}",
                    classpath=classpath,
                )
            )

        generated = [
            (f"net.minecraftforge:forge:{forge_coordinate_version}:client", False),
            (f"net.minecraft:client:{minecraft_version}-20230612.114412:srg", False),
            (f"net.minecraft:client:{minecraft_version}-20230612.114412:slim", False),
            (f"net.minecraft:client:{minecraft_version}-20230612.114412:extra", False),
        ]
        for identifier, classpath in generated:
            relative = coordinate_path(identifier)
            local_path = libraries_root / Path(*relative.parts)
            public_path = public_root / "forge" / "generated" / Path(*relative.parts)
            public_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(local_path, public_path)
            submodules.append(
                library_module(
                    identifier,
                    public_path,
                    encoded_url(base_url, "forge", "generated", relative.as_posix()),
                    classpath=classpath,
                )
            )

        for library in profile.get("libraries", []):
            download_info = library.get("downloads", {}).get("artifact")
            if not download_info:
                raise ValueError(f"Forge library has no artifact download: {library.get('name')}")
            local_path = libraries_root / Path(*safe_relative_path(download_info["path"]).parts)
            if local_path.stat().st_size != int(download_info["size"]):
                raise ValueError(f"Forge library size mismatch: {library['name']}")
            submodules.append(
                library_module(library["name"], local_path, download_info["url"])
            )

        root_identifier = f"net.minecraftforge:lowcodelanguage:{forge_coordinate_version}"
        root_relative = coordinate_path(root_identifier)
        return {
            "id": root_identifier,
            "name": f"Minecraft Forge {forge_version}",
            "type": "ForgeHosted",
            "classpath": True,
            "artifact": artifact(
                libraries_root / Path(*root_relative.parts),
                f"https://maven.minecraftforge.net/{root_relative.as_posix()}",
            ),
            "subModules": submodules,
        }


def load_news(path: Path) -> dict:
    news = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(news.get("items"), list):
        raise ValueError(f"{path}: 'items' must be a list")
    for index, item in enumerate(news["items"]):
        for field in ("id", "title", "date", "html"):
            if not isinstance(item.get(field), str) or not item[field].strip():
                raise ValueError(f"{path}: items[{index}].{field} is required")
        parsed = datetime.fromisoformat(item["date"])
        if parsed.tzinfo is None:
            raise ValueError(f"{path}: items[{index}].date must include a UTC offset")
    return news


def cdata(value: str) -> str:
    return "<![CDATA[" + value.replace("]]>", "]]]]><![CDATA[>") + "]]>"


def write_news(public_root: Path, base_url: str, news: dict) -> None:
    items = sorted(news["items"], key=lambda item: datetime.fromisoformat(item["date"]), reverse=True)
    entries = []
    for item in items:
        entries.append(
            f"""    <item>
      <title>{xml_escape(item['title'])}</title>
      <link>{xml_escape(item.get('link') or base_url)}</link>
      <description>{xml_escape(item.get('summary', ''))}</description>
      <content:encoded>{cdata(item['html'])}</content:encoded>
      <dc:creator>{xml_escape(item.get('author', 'GordosGang'))}</dc:creator>
      <pubDate>{format_datetime(datetime.fromisoformat(item['date']))}</pubDate>
      <guid isPermaLink="false">{xml_escape(item['id'])}</guid>
    </item>"""
        )
    feed = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>{xml_escape(news.get('title', 'GordosGang Launcher'))}</title>
    <link>{xml_escape(base_url)}</link>
    <description>{xml_escape(news.get('description', ''))}</description>
    <language>es</language>
{os.linesep.join(entries)}
  </channel>
</rss>
"""
    (public_root / "news.xml").write_text(feed, encoding="utf-8")


def publish(staging: Path, destination: Path) -> None:
    previous = destination.with_name(destination.name + ".previous")
    if previous.exists():
        shutil.rmtree(previous)
    if destination.exists():
        destination.rename(previous)
    try:
        staging.rename(destination)
    except Exception:
        if previous.exists() and not destination.exists():
            previous.rename(destination)
        raise
    if previous.exists():
        shutil.rmtree(previous)


def main() -> None:
    args = parse_args()
    base_url = args.base_url.rstrip("/")
    parent = args.public_dir.resolve().parent
    parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="launcher-public-bmc4-", dir=parent))
    try:
        with zipfile.ZipFile(args.client_pack) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            if manifest.get("manifestType") != "minecraftModpack":
                raise ValueError("The supplied archive is not a CurseForge Minecraft modpack")
            minecraft = manifest["minecraft"]
            minecraft_version = minecraft["version"]
            primary_loaders = [item["id"] for item in minecraft["modLoaders"] if item.get("primary")]
            if len(primary_loaders) != 1 or not primary_loaders[0].startswith("forge-"):
                raise ValueError(f"Expected one primary Forge loader, got {primary_loaders}")
            forge_version = primary_loaders[0].removeprefix("forge-")

            excluded_names = {name.casefold() for name in args.exclude_curse_file}
            curse_modules, occupied = build_curse_modules(
                manifest, args.curse_api_base, args.workers, excluded_names
            )
            official_mod_names = {
                module["name"].casefold()
                for module in curse_modules
                if module["name"].casefold().endswith(".jar")
            }
            override_bundle, override_count, extra_count = add_override_bundle(
                archive,
                manifest,
                staging,
                base_url,
                occupied,
                args.extra_pack,
                official_mod_names,
            )

        forge_module = build_forge_module(
            staging,
            base_url,
            minecraft_version,
            forge_version,
            args.java,
            args.forge_installer,
        )
        modules = [forge_module, *curse_modules, override_bundle]

        assets = staging / "assets"
        assets.mkdir(parents=True, exist_ok=True)
        shutil.copy2(args.icon, assets / args.icon.name)
        news = load_news(args.news)
        write_news(staging, base_url, news)

        distribution = {
            "version": "1.0.0",
            "rss": f"{base_url}/news.xml",
            "servers": [
                {
                    "id": args.server_id,
                    "name": args.server_name,
                    "description": f"Better MC 4 {manifest['version']} · Forge {minecraft_version}",
                    "icon": encoded_url(base_url, "assets", args.icon.name),
                    "version": manifest["version"],
                    "address": args.server_address,
                    "minecraftVersion": minecraft_version,
                    "javaOptions": {
                        "supported": ">=17 <18",
                        "suggestedMajor": 17,
                        "ram": {
                            "recommended": args.recommended_ram,
                            "minimum": args.minimum_ram,
                        },
                    },
                    "mainServer": True,
                    "autoconnect": True,
                    "modules": modules,
                }
            ],
        }
        (staging / "distribution.json").write_text(
            json.dumps(distribution, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (staging / "health.json").write_text(
            json.dumps(
                {
                    "status": "ok",
                    "server": args.server_address,
                    "pack": manifest["version"],
                    "minecraft": minecraft_version,
                    "forge": forge_version,
                    "modules": len(modules),
                    "curseforgeArtifacts": len(curse_modules),
                    "overrides": override_count,
                    "arclightExtras": extra_count,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        publish(staging, args.public_dir)
        print(f"Published {len(modules)} modules to {args.public_dir}", flush=True)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


if __name__ == "__main__":
    main()
