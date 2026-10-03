#!/usr/bin/env python3
"""Build a Helios distribution from the Homestead Modrinth pack.

The generated directory is safe to expose publicly: it contains only the
distribution index, client overrides, client/both-side extras, Fabric metadata,
and launcher artwork. Official Modrinth artifacts keep their CDN URLs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import tempfile
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime
from email.utils import format_datetime
from pathlib import Path, PurePosixPath
from xml.sax.saxutils import escape as xml_escape


USER_AGENT = "GordosGang-Launcher/2.2.1"

# Extras that must not be published at the version the lock file names, keyed by
# the filename prefix the rule covers. The replacement is downloaded from the
# declared URL and checked against the declared sha1 before it is published, so
# a pin can never silently become something else.
#
# Distant Horizons 3.x calls ThreadPoolUtil.shutdownThreadPools() without a null
# check on networkClientHandlerThreadPool, so every client disconnect (kick,
# timeout, or the Disconnect button) raises a NullPointerException and takes the
# whole game down instead of showing the disconnect screen. Verified present in
# 3.2.0-b, 3.3.2 and 3.3.3; 2.4.5-b predates that pool and cannot hit it.
# Pack files that must not be published, keyed by the filename prefix the rule
# covers. An exclusion is two-sided: the file is dropped from the client
# distribution and the sync refuses to run if it is still installed on the
# server, so a mod can never be removed from one side while it keeps running on
# the other.
#
# sodiumoptionsmodcompat 1.0.0 builds Sodium's Video Settings page for Entity
# Model Features against an older EMF enum set: it supplies 6 names for
# RenderModeChoice (EMF 3.3.9 declares 5, GREEN was removed), 4 for
# ModelPrintMode (declares 5) and 2 for VanillaModelRenderMode (declares 3).
# Sodium's CyclingControl validates those lengths, so opening Video Settings
# throws IllegalArgumentException and kills the client. The integration only
# activates because EMF is added as an extra - the stock pack ships no EMF - and
# nothing in the pack depends on this mod, so dropping it costs only the
# convenience of editing ETF/EMF settings from inside Sodium's screen.
PACK_EXCLUSIONS = {
    "sodiumoptionsmodcompat-": (
        "crashes Video Settings against the EMF version this pack adds"
    ),
}

EXTRA_PINS = {
    "DistantHorizons-3.": {
        "filename": "DistantHorizons-2.4.5-b-1.20.1-fabric-forge.jar",
        "url": (
            "https://cdn.modrinth.com/data/uCdwusMi/versions/lC6CwqPp/"
            "DistantHorizons-2.4.5-b-1.20.1-fabric-forge.jar"
        ),
        "sha1": "ce3814dd5971edda4d04c3a42ef0df5c6cf8e10d",
        "size": 25378978,
        "reason": "DH 3.x crashes the client on every disconnect",
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--news-only",
        action="store_true",
        help="only rewrite news.xml in --public-dir; the client is left untouched",
    )
    parser.add_argument("--public-dir", required=True, type=Path)
    parser.add_argument("--base-url", required=True)
    parser.add_argument(
        "--news",
        type=Path,
        help=f"news JSON; defaults to {DEFAULT_NEWS_FILE.name} next to this script",
    )
    parser.add_argument("--mrpack", type=Path)
    parser.add_argument("--server-address")
    parser.add_argument("--server-data", type=Path)
    parser.add_argument("--extras-root", type=Path)
    parser.add_argument("--icon", type=Path)
    args = parser.parse_args()
    if not args.news_only:
        missing = [
            "--" + name.replace("_", "-")
            for name in ("mrpack", "server_address", "server_data", "extras_root", "icon")
            if getattr(args, name) is None
        ]
        if missing:
            parser.error("the following arguments are required: " + ", ".join(missing))
    return args


def safe_relative_path(value: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"Unsafe relative path: {value}")
    return path


def file_hash(path: Path, algorithm: str) -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def request(url: str):
    return urllib.request.urlopen(
        urllib.request.Request(url, headers={"User-Agent": USER_AGENT}),
        timeout=60,
    )


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with request(url) as response, destination.open("wb") as output:
        shutil.copyfileobj(response, output, length=1024 * 1024)


def download_json(url: str) -> dict:
    with request(url) as response:
        return json.load(response)


def encoded_url(base_url: str, *parts: str) -> str:
    encoded = "/".join(
        urllib.parse.quote(part, safe="")
        for value in parts
        for part in PurePosixPath(value).parts
    )
    return f"{base_url.rstrip('/')}/{encoded}"


def slug(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9._-]+", "-", value.lower()).strip("-.")
    return cleaned[:64] or "artifact"


def artifact(path: Path, url: str, relative_path: str | None = None) -> dict:
    result = {
        "size": path.stat().st_size,
        "MD5": file_hash(path, "md5"),
        "url": url,
    }
    if relative_path is not None:
        result["path"] = relative_path
    return result


def verify_declared_hash(path: Path, hashes: dict) -> bool:
    for algorithm in ("sha512", "sha1"):
        expected = hashes.get(algorithm)
        if expected:
            return file_hash(path, algorithm) == expected
    return True


def version_numbers(value: str) -> tuple[int, ...]:
    """Return the numeric core used by Fabric Loader version predicates."""
    match = re.match(r"^(\d+(?:\.\d+)*)", value.strip())
    if match is None:
        raise ValueError(f"Unsupported Fabric Loader version: {value}")
    return tuple(int(part) for part in match.group(1).split("."))


def compare_versions(left: str, right: str) -> int:
    left_parts = version_numbers(left)
    right_parts = version_numbers(right)
    width = max(len(left_parts), len(right_parts))
    left_parts += (0,) * (width - len(left_parts))
    right_parts += (0,) * (width - len(right_parts))
    return (left_parts > right_parts) - (left_parts < right_parts)


def loader_requirement_satisfied(requirement, loader_version: str) -> bool:
    if requirement is None or requirement == "*":
        return True
    if isinstance(requirement, list):
        return any(
            loader_requirement_satisfied(candidate, loader_version)
            for candidate in requirement
        )
    if not isinstance(requirement, str):
        raise ValueError(f"Unsupported Fabric Loader dependency: {requirement!r}")

    # Fabric allows alternatives separated by || and whitespace-separated
    # comparator clauses. Reject syntax we do not understand so a bad update
    # can never be published silently.
    alternatives = [item.strip() for item in requirement.split("||")]
    for alternative in alternatives:
        clauses = alternative.split()
        if not clauses:
            continue
        matches = True
        for clause in clauses:
            match = re.fullmatch(r"(>=|<=|>|<|=)?(\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)", clause)
            if match is None:
                raise ValueError(
                    f"Unsupported Fabric Loader dependency clause: {clause}"
                )
            operator = match.group(1) or "="
            comparison = compare_versions(loader_version, match.group(2))
            matches = matches and {
                ">=": comparison >= 0,
                "<=": comparison <= 0,
                ">": comparison > 0,
                "<": comparison < 0,
                "=": comparison == 0,
            }[operator]
        if matches:
            return True
    return False


def validate_extra_loader(path: Path, loader_version: str) -> None:
    try:
        with zipfile.ZipFile(path) as archive:
            # strict=False because real mods ship unescaped newlines inside
            # description strings. Fabric Loader's own parser accepts them, so
            # refusing to publish over it would reject a mod the game runs fine.
            metadata = json.loads(archive.read("fabric.mod.json"), strict=False)
    except KeyError as error:
        raise ValueError(f"Missing fabric.mod.json in client mod: {path.name}") from error
    except json.JSONDecodeError as error:
        raise ValueError(
            f"Unparseable fabric.mod.json in client mod {path.name}: {error}"
        ) from error
    requirement = metadata.get("depends", {}).get("fabricloader")
    if not loader_requirement_satisfied(requirement, loader_version):
        raise ValueError(
            f"{path.name} requires Fabric Loader {requirement!r}, "
            f"but the pack uses {loader_version}"
        )


def resolve_remote_md5(entry: dict, server_data: Path, scratch: Path) -> str:
    relative = safe_relative_path(entry["path"])
    candidate = server_data.joinpath(*relative.parts)
    if candidate.is_file() and verify_declared_hash(candidate, entry.get("hashes", {})):
        return file_hash(candidate, "md5")

    target = scratch / f"artifact-{hashlib.sha1(entry['path'].encode()).hexdigest()}"
    download(entry["downloads"][0], target)
    if target.stat().st_size != entry["fileSize"]:
        raise ValueError(f"Unexpected size for {entry['path']}")
    if not verify_declared_hash(target, entry.get("hashes", {})):
        raise ValueError(f"Hash mismatch for {entry['path']}")
    return file_hash(target, "md5")


def maven_path(identifier: str) -> str:
    group, name, version = identifier.split(":", 2)
    return f"{group.replace('.', '/')}/{name}/{version}/{name}-{version}.jar"


def build_loader_modules(
    public_root: Path,
    base_url: str,
    minecraft_version: str,
    loader_version: str,
) -> dict:
    loader_dir = public_root / "fabric"
    loader_dir.mkdir(parents=True, exist_ok=True)

    loader_name = f"fabric-loader-{loader_version}.jar"
    loader_path = loader_dir / loader_name
    loader_url = (
        "https://maven.fabricmc.net/net/fabricmc/fabric-loader/"
        f"{loader_version}/{loader_name}"
    )
    download(loader_url, loader_path)

    profile = download_json(
        "https://meta.fabricmc.net/v2/versions/loader/"
        f"{minecraft_version}/{loader_version}/profile/json"
    )
    profile_name = f"{profile['id']}.json"
    profile_path = loader_dir / profile_name
    profile_path.write_text(json.dumps(profile, indent=2) + "\n", encoding="utf-8")

    submodules = [
        {
            "id": profile["id"],
            "name": "Fabric client profile",
            "type": "VersionManifest",
            "artifact": artifact(
                profile_path,
                encoded_url(base_url, "fabric", profile_name),
            ),
        }
    ]

    for library in profile.get("libraries", []):
        if library["name"] == f"net.fabricmc:fabric-loader:{loader_version}":
            continue
        library_url = urllib.parse.urljoin(library["url"], maven_path(library["name"]))
        library_size = library.get("size")
        library_md5 = library.get("md5")
        if library_size is None or library_md5 is None:
            with tempfile.NamedTemporaryFile() as temporary:
                download(library_url, Path(temporary.name))
                library_size = Path(temporary.name).stat().st_size
                library_md5 = file_hash(Path(temporary.name), "md5")
        submodules.append(
            {
                "id": library["name"],
                "name": library["name"],
                "type": "Library",
                "artifact": {
                    "size": library_size,
                    "MD5": library_md5,
                    "url": library_url,
                },
            }
        )

    return {
        "id": f"net.fabricmc:fabric-loader:{loader_version}",
        "name": f"Fabric Loader {loader_version}",
        "type": "Fabric",
        "artifact": artifact(
            loader_path,
            encoded_url(base_url, "fabric", loader_name),
        ),
        "subModules": submodules,
    }


def excluded_reason(filename: str) -> str | None:
    for prefix, reason in PACK_EXCLUSIONS.items():
        if filename.startswith(prefix):
            return reason
    return None


def verify_exclusions_absent_from_server(server_data: Path) -> None:
    """Refuse to publish while an excluded mod is still installed server-side.

    An exclusion exists because the mod is harmful, so leaving it running on the
    server while dropping it from the client is never what was intended. Failing
    here is the only way that cannot pass unnoticed.
    """
    mods_dir = server_data / "mods"
    if not mods_dir.is_dir():
        print(f"  no {mods_dir} to check for exclusions", flush=True)
        return
    for path in sorted(mods_dir.iterdir()):
        reason = excluded_reason(path.name) if path.is_file() else None
        if reason is not None:
            raise ValueError(
                f"{path.name} is excluded from the client ({reason}) but is still "
                f"installed on the server at {path}. Remove it there first."
            )
    print(
        f"Exclusions: none of {len(PACK_EXCLUSIONS)} rule(s) match a server mod",
        flush=True,
    )


def add_pack_modules(index: dict, server_data: Path, scratch: Path) -> list[dict]:
    modules = []
    version = index["versionId"]
    skipped = []
    for position, entry in enumerate(index["files"], start=1):
        relative = safe_relative_path(entry["path"])
        reason = excluded_reason(relative.name)
        if reason is not None:
            skipped.append((relative.name, reason))
            print(f"[{position:03d}/{len(index['files'])}] excluded: {relative.name}", flush=True)
            continue
        is_mod = relative.parts[0] == "mods" and relative.suffix.lower() == ".jar"
        destination = f"pack/{relative.name}" if is_mod else relative.as_posix()
        module = {
            "id": f"gg.homestead.pack:artifact-{position:04d}:{version}",
            "name": relative.name,
            "type": "FabricMod" if is_mod else "File",
            "artifact": {
                "size": entry["fileSize"],
                "MD5": resolve_remote_md5(entry, server_data, scratch),
                "url": entry["downloads"][0],
                "path": destination,
            },
        }
        modules.append(module)
        print(f"[{position:03d}/{len(index['files'])}] {entry['path']}", flush=True)
    for name, reason in skipped:
        print(f"Excluded from the client: {name} ({reason})", flush=True)
    return modules


def collect_overrides(archive: zipfile.ZipFile) -> dict[str, bytes]:
    overrides: dict[str, bytes] = {}
    for prefix in ("overrides/", "client-overrides/"):
        for info in archive.infolist():
            if info.is_dir() or not info.filename.startswith(prefix):
                continue
            relative = safe_relative_path(info.filename[len(prefix):]).as_posix()
            overrides[relative] = archive.read(info)
    return overrides


# The pack seeds a player's options.txt through these two mods on first launch.
OPTIONS_SEED_FILES = (
    "config/defaultoptions/options.txt",
    "config/yosbr/options.txt",
)


def client_resourcepack_names(extras_root: Path) -> list[str]:
    """Filenames of the non-jar client extras, in lock order."""
    lock = json.loads((extras_root / "modpack.lock.json").read_text(encoding="utf-8"))
    names = []
    for item in lock["added_mods"]:
        filename = item["filename"]
        if normalize_side(item.get("side"), filename) not in PUBLISHED_SIDES:
            continue
        if not filename.lower().endswith(".jar"):
            names.append(filename)
    return names


def collect_local_overrides(extras_root: Path) -> dict[str, bytes]:
    """Files published on top of the pack's own overrides.

    Same semantics as a pack override: the key is the instance-relative path and
    the launcher restores the file whenever it differs. A local override replaces
    the pack's file at the same path instead of adding a second module for it,
    which would leave two modules fighting over one destination.

    Use this for settings the pack cannot carry because they belong to a mod
    added here rather than to the pack itself.
    """
    root = extras_root / "staging" / "overrides"
    if not root.is_dir():
        return {}
    collected = {}
    for path in sorted(root.rglob("*")):
        if path.is_dir():
            continue
        relative = safe_relative_path(
            path.relative_to(root).as_posix()
        ).as_posix()
        collected[relative] = path.read_bytes()
    return collected


def enable_client_resourcepacks(overrides: dict[str, bytes], names: list[str]) -> None:
    """Add local resourcepack extras to the lists the pack seeds on first launch.

    The pack's own defaults cannot know about packs added here, so a resourcepack
    extra arrives installed but switched off, which looks exactly like it was
    never delivered. Appending puts it last in the list, which is the highest
    priority in Minecraft's resource pack order.
    """
    if not names:
        return
    wanted = [f"file/{name}" for name in names]
    patched_any = False
    for path in OPTIONS_SEED_FILES:
        blob = overrides.get(path)
        if blob is None:
            print(f"  no {path} in this pack, skipping", flush=True)
            continue
        lines = blob.decode("utf-8").split("\n")
        for index, line in enumerate(lines):
            if not line.startswith("resourcePacks:"):
                continue
            current = json.loads(line[len("resourcePacks:"):])
            added = [entry for entry in wanted if entry not in current]
            if added:
                lines[index] = "resourcePacks:" + json.dumps(
                    current + added, separators=(",", ":")
                )
                overrides[path] = "\n".join(lines).encode("utf-8")
                print(f"  enabled in {path}: {', '.join(added)}", flush=True)
            patched_any = True
            break
        else:
            raise ValueError(f"No resourcePacks line found in {path}")
    if not patched_any:
        raise ValueError(
            "Found no options seed file to enable client resourcepacks in; "
            f"expected one of {list(OPTIONS_SEED_FILES)}"
        )


def add_override_modules(
    overrides: dict[str, bytes],
    public_root: Path,
    base_url: str,
    pack_version: str,
) -> list[dict]:
    modules = []
    for position, (name, content) in enumerate(sorted(overrides.items()), start=1):
        relative = safe_relative_path(name)
        public_path = public_root / "files" / Path(*relative.parts)
        public_path.parent.mkdir(parents=True, exist_ok=True)
        public_path.write_bytes(content)
        is_mod = relative.parts[0] == "mods" and relative.suffix.lower() == ".jar"
        modules.append(
            {
                "id": f"gg.homestead.override:artifact-{position:04d}:{pack_version}",
                "name": relative.name,
                "type": "FabricMod" if is_mod else "File",
                "artifact": artifact(
                    public_path,
                    encoded_url(base_url, "files", relative.as_posix()),
                    f"embedded/{relative.name}" if is_mod else relative.as_posix(),
                ),
            }
        )
    return modules


PUBLISHED_SIDES = {"both", "client"}

# Spellings seen in hand-edited lock files, mapped onto the three canonical
# sides. Anything outside this table is a hard error: a client mod that the
# launcher silently drops because its side was typed "client-only" is exactly
# the kind of omission nobody notices until a player reports missing mods.
SIDE_ALIASES = {
    "both": "both",
    "all": "both",
    "common": "both",
    "client": "client",
    "client_only": "client",
    "clientside": "client",
    "clientonly": "client",
    "server": "server",
    "server_only": "server",
    "serverside": "server",
    "serveronly": "server",
}


def normalize_side(value, filename: str) -> str:
    if value is None:
        raise ValueError(f"Lock entry for {filename} declares no side")
    canonical = SIDE_ALIASES.get(str(value).strip().lower().replace("-", "_"))
    if canonical is None:
        raise ValueError(
            f"Lock entry for {filename} declares an unknown side {value!r}; "
            f"expected one of {sorted(set(SIDE_ALIASES))}"
        )
    return canonical


def resolve_pin(filename: str, scratch: Path) -> tuple[str, Path] | None:
    """Return the (filename, path) a pinned extra must be published as."""
    for prefix, pin in EXTRA_PINS.items():
        if not filename.startswith(prefix):
            continue
        if filename == pin["filename"]:
            return None
        target = scratch / pin["filename"]
        if not target.is_file():
            download(pin["url"], target)
        if target.stat().st_size != pin["size"]:
            raise ValueError(f"Unexpected size for pinned extra {pin['filename']}")
        if file_hash(target, "sha1") != pin["sha1"]:
            raise ValueError(f"Hash mismatch for pinned extra {pin['filename']}")
        print(
            f"  pinned {filename} -> {pin['filename']} ({pin['reason']})",
            flush=True,
        )
        return pin["filename"], target
    return None


def add_extra_modules(
    extras_root: Path,
    public_root: Path,
    base_url: str,
    pack_version: str,
    loader_version: str,
    scratch: Path,
) -> list[dict]:
    lock = json.loads((extras_root / "modpack.lock.json").read_text(encoding="utf-8"))
    modules = []
    seen = set()
    skipped = []
    for position, item in enumerate(lock["added_mods"], start=1):
        side = normalize_side(item.get("side"), item["filename"])
        if side not in PUBLISHED_SIDES:
            skipped.append(item["filename"])
            continue
        filename = item["filename"]
        candidates = (
            extras_root / "staging" / "mods" / filename,
            extras_root / "staging" / "clientmods" / filename,
            extras_root / "staging" / "clientresourcepacks" / filename,
        )
        source = next((candidate for candidate in candidates if candidate.is_file()), None)
        if source is None:
            raise FileNotFoundError(f"Missing client extra: {filename}")

        pinned = resolve_pin(filename, scratch)
        if pinned is not None:
            filename, source = pinned

        if filename in seen:
            continue
        seen.add(filename)

        is_mod = source.suffix.lower() == ".jar"
        if is_mod:
            validate_extra_loader(source, loader_version)
        public_kind = "mods" if is_mod else "resourcepacks"
        public_path = public_root / "extras" / public_kind / filename
        public_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, public_path)
        destination = f"extras/{filename}" if is_mod else f"resourcepacks/{filename}"
        modules.append(
            {
                "id": f"gg.homestead.extra:{slug(source.stem)}-{position:02d}:{pack_version}",
                "name": item.get("name") or source.stem,
                "type": "FabricMod" if is_mod else "File",
                "artifact": artifact(
                    public_path,
                    encoded_url(base_url, "extras", public_kind, filename),
                    destination,
                ),
            }
        )
    print(
        f"Extras: published {len(modules)}, skipped {len(skipped)} server-side",
        flush=True,
    )
    for name in skipped:
        print(f"  server-side, not published: {name}", flush=True)
    return modules


DEFAULT_NEWS_FILE = Path(__file__).with_name("homestead-news.json")

DEFAULT_NEWS = {
    "title": "GordosGang Launcher",
    "description": "Noticias del servidor Homestead",
    "items": [
        {
            "id": "homestead-1.3.7",
            "title": "Homestead disponible",
            "date": "2026-10-03T15:00:00+00:00",
            "author": "GordosGang",
            "summary": "El launcher está conectado con Homestead 1.3.7.",
            "html": "<p>El launcher ya descarga y valida el cliente oficial de Homestead 1.3.7.</p>",
        }
    ],
}


def load_news(path: Path | None) -> dict:
    if path is None:
        if not DEFAULT_NEWS_FILE.exists():
            return DEFAULT_NEWS
        path = DEFAULT_NEWS_FILE
    news = json.loads(path.read_text(encoding="utf-8"))
    items = news.get("items")
    if not isinstance(items, list):
        raise SystemExit(f"{path}: 'items' must be a list")
    for index, item in enumerate(items):
        for field in ("id", "title", "date", "html"):
            if not isinstance(item.get(field), str) or not item[field].strip():
                raise SystemExit(f"{path}: items[{index}].{field} is required")
        try:
            parse_news_date(item["date"])
        except ValueError as error:
            raise SystemExit(f"{path}: items[{index}].date: {error}") from None
    return news


def parse_news_date(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError("include a UTC offset, e.g. 2026-10-03T15:00:00-03:00")
    return parsed


def cdata(value: str) -> str:
    return "<![CDATA[" + value.replace("]]>", "]]]]><![CDATA[>") + "]]>"


def write_news(public_root: Path, base_url: str, news: dict) -> None:
    items = sorted(news["items"], key=lambda item: parse_news_date(item["date"]), reverse=True)
    entries = []
    for item in items:
        link = item.get("link") or base_url
        entries.append(f"""    <item>
      <title>{xml_escape(item["title"])}</title>
      <link>{xml_escape(link)}</link>
      <description>{xml_escape(item.get("summary", ""))}</description>
      <content:encoded>{cdata(item["html"])}</content:encoded>
      <dc:creator>{xml_escape(item.get("author", "GordosGang"))}</dc:creator>
      <pubDate>{format_datetime(parse_news_date(item["date"]))}</pubDate>
      <guid isPermaLink="false">{xml_escape(item["id"])}</guid>
    </item>""")
    body = "\n".join(entries)
    feed = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>{xml_escape(news.get("title", "GordosGang Launcher"))}</title>
    <link>{xml_escape(base_url)}</link>
    <description>{xml_escape(news.get("description", ""))}</description>
    <language>es</language>
{body}
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
    staging.rename(destination)
    if previous.exists():
        shutil.rmtree(previous)


def main() -> None:
    args = parse_args()
    base_url = args.base_url.rstrip("/")
    news = load_news(args.news)
    if args.news_only:
        write_news(args.public_dir, base_url, news)
        print(f"Wrote {args.public_dir / 'news.xml'} ({len(news['items'])} items)")
        return
    parent = args.public_dir.parent
    parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="launcher-public-", dir=parent))

    try:
        with zipfile.ZipFile(args.mrpack) as archive, tempfile.TemporaryDirectory() as scratch_dir:
            index = json.loads(archive.read("modrinth.index.json"))
            minecraft_version = index["dependencies"]["minecraft"]
            loader_version = index["dependencies"]["fabric-loader"]
            pack_version = index["versionId"]

            # Before building anything: an exclusion has to hold on both sides.
            verify_exclusions_absent_from_server(args.server_data)

            modules = [
                build_loader_modules(
                    staging,
                    base_url,
                    minecraft_version,
                    loader_version,
                )
            ]
            modules.extend(
                add_pack_modules(index, args.server_data, Path(scratch_dir))
            )
            overrides = collect_overrides(archive)
            local_overrides = collect_local_overrides(args.extras_root)
            for path in sorted(local_overrides):
                origin = "replaces pack file" if path in overrides else "new file"
                print(f"  local override: {path} ({origin})", flush=True)
            overrides.update(local_overrides)
            enable_client_resourcepacks(
                overrides, client_resourcepack_names(args.extras_root)
            )
            modules.extend(
                add_override_modules(
                    overrides,
                    staging,
                    base_url,
                    pack_version,
                )
            )
            modules.extend(
                add_extra_modules(
                    args.extras_root,
                    staging,
                    base_url,
                    pack_version,
                    loader_version,
                    Path(scratch_dir),
                )
            )

        assets = staging / "assets"
        assets.mkdir(parents=True, exist_ok=True)
        shutil.copy2(args.icon, assets / args.icon.name)
        write_news(staging, base_url, news)

        distribution = {
            "version": "1.0.0",
            "rss": f"{base_url}/news.xml",
            "servers": [
                {
                    "id": "Homestead-1.20.1",
                    "name": "Homestead",
                    "description": "Homestead 1.3.7 · Fabric 1.20.1",
                    "icon": encoded_url(base_url, "assets", args.icon.name),
                    "version": pack_version,
                    "address": args.server_address,
                    "minecraftVersion": minecraft_version,
                    "javaOptions": {
                        "supported": ">=17 <22",
                        "suggestedMajor": 17,
                        "ram": {"recommended": 8192, "minimum": 4096},
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
                    "pack": pack_version,
                    "modules": len(modules),
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        publish(staging, args.public_dir)
        print(
            f"Published {len(modules)} modules to {args.public_dir}",
            flush=True,
        )
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


if __name__ == "__main__":
    main()
