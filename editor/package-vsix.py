"""Build one VSIX with the native parsers supported by the loadwise lockfile."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile
import zipfile


EDITOR = Path(__file__).resolve().parent
PACKAGE_ROOT = EDITOR.parent
NPM = shutil.which("npm.cmd" if os.name == "nt" else "npm")
VSCE = "@vscode/vsce@4.1.1"
AST_GREP = "@ast-grep/cli"


def stage_checker(source, stage, package_name, tool_name):
    inventory = subprocess.check_output([NPM, "pack", "--dry-run", "--json", "--ignore-scripts"], cwd=source)
    package, = json.loads(inventory)
    if package["name"] != package_name:
        raise ValueError(f"Expected {package_name} in {source}")
    stage_resolved = stage.resolve()
    for entry in package["files"]:
        relative = PurePosixPath(entry["path"])
        if not relative.parts or relative.is_absolute() or ".." in relative.parts:
            raise ValueError(f"Unsafe pack path {entry['path']!r} in {package_name}")
        editor_module = len(relative.parts) == 2 and relative.parts[0] == "editor" and relative.suffix == ".cjs"
        if relative.parts[0] in {"bin", "lib", "polyglot", "package.json"} or editor_module:
            target = (stage / "tools" / tool_name / relative).resolve()
            target.relative_to(stage_resolved)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / relative, target)


def runtime_files(package, relative):
    if relative == "package.json":
        return True
    if package == "typescript":
        return relative in {"LICENSE.txt", "ThirdPartyNoticeText.txt", "lib/typescript.js"} or (
            relative.startswith("lib/lib") and relative.endswith(".d.ts") and relative.count("/") == 1
        )
    if package == "detect-libc":
        return relative == "LICENSE" or (relative.startswith("lib/") and relative.endswith(".js"))
    if package == AST_GREP:
        return relative == "postinstall.js"
    if package == "libpg-query":
        return relative in {"LICENSE", "wasm/index.cjs", "wasm/libpg-query.js", "wasm/libpg-query.wasm"}
    if package == "@pgsql/types":
        return relative in {"LICENSE", "index.js", "enums.js", "types.js"}
    return relative == ("ast-grep.exe" if "-win32-" in package else "ast-grep")


def stage_runtime(downloads, stage, lock):
    variants = lock[f"node_modules/{AST_GREP}"]["optionalDependencies"]
    packages = ["typescript", "detect-libc", "libpg-query", "@pgsql/types", AST_GREP, *sorted(variants)]
    urls = []
    for name in packages:
        urls.append(lock[f"node_modules/{name}"]["resolved"])
    subprocess.run([NPM, "pack", "--silent", "--prefer-offline", "--ignore-scripts", *urls], cwd=downloads, check=True)
    executables = {}
    for name in packages:
        entry = lock[f"node_modules/{name}"]
        archive_name = f"{name.lstrip('@').replace('/', '-')}-{entry['version']}.tgz"
        archive = downloads / archive_name
        digest = base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode("ascii")
        if entry["integrity"] != "sha512-" + digest:
            raise ValueError(f"Lockfile integrity mismatch for {name}")
        staged = set()
        with tarfile.open(archive, "r|gz") as contents:
            for member in contents:
                path = PurePosixPath(member.name)
                if not member.isfile() or path.parts[:1] != ("package",) or ".." in path.parts:
                    continue
                relative = path.relative_to("package").as_posix()
                if not runtime_files(name, relative):
                    continue
                target = (stage / "tools/node_modules" / name / relative).resolve()
                target.relative_to(stage.resolve())
                if name in variants and relative == "ast-grep":
                    # vsce on Windows drops POSIX executable bits. Append these six
                    # binaries using explicit Unix ZIP metadata after vsce builds the manifest.
                    target = (downloads / (name.split("/")[-1] + "-ast-grep")).resolve()
                    target.relative_to(downloads.resolve())
                    executables[f"extension/tools/node_modules/{name}/ast-grep"] = target
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("wb") as dest:
                    shutil.copyfileobj(contents.extractfile(member), dest)
                staged.add(relative)
        if name in variants:
            entrypoint = "ast-grep.exe" if "-win32-" in name else "ast-grep"
        else:
            entrypoint = {"typescript": "lib/typescript.js", "detect-libc": "lib/detect-libc.js",
                          "libpg-query": "wasm/index.cjs", AST_GREP: "postinstall.js"}.get(name, "index.js")
        if not {"package.json", entrypoint}.issubset(staged):
            raise ValueError(f"Missing runtime files in {name}")

    return executables


def build(output):
    if not NPM or output.suffix.lower() != ".vsix":
        raise ValueError("npm must be installed and the output filename must end in .vsix")
    with tempfile.TemporaryDirectory(prefix="loadwise-vsix-") as temp:
        root = Path(temp)
        stage = root / "extension"
        stage.mkdir()
        stage_checker(PACKAGE_ROOT, stage, "loadwise", "loadwise")
        for source in [*EDITOR.glob("*.cjs"), EDITOR / "package.json", EDITOR / "README.md"]:
            # Shared editor modules can import the checker's library relative to their packaged location.
            bundled = Path("tools/loadwise/editor") / source.name
            if (stage / bundled).is_file():
                (stage / source.name).write_text(f"module.exports = require('./{bundled.as_posix()}');\n", encoding="utf-8")
            else:
                shutil.copyfile(source, stage / source.name)
        shutil.copytree(EDITOR / "licenses", stage / "licenses")
        subprocess.run(["node", "-e", "require('./diagnostics.cjs')"], cwd=stage, check=True)
        lock = json.loads((PACKAGE_ROOT / "package-lock.json").read_bytes())["packages"]
        executables = stage_runtime(root, stage, lock)
        output.parent.mkdir(parents=True, exist_ok=True)
        # Build beside the destination so replacement is atomic even on another volume.
        with tempfile.NamedTemporaryFile(prefix=".loadwise-", suffix=".vsix", dir=output.parent, delete=False) as file:
            artifact = Path(file.name)
        try:
            subprocess.run(
                [NPM, "exec", "--yes", f"--package={VSCE}", "--", "vsce", "package", "--no-dependencies",
                 "--allow-missing-repository", "--skip-license", "--out", str(artifact)],
                cwd=stage, check=True,
            )
            with zipfile.ZipFile(artifact, "a") as package:
                for relative, binary in executables.items():
                    info = zipfile.ZipInfo(relative)
                    info.create_system = 3
                    info.external_attr = 0o100755 << 16
                    info.compress_type = zipfile.ZIP_DEFLATED
                    with binary.open("rb") as src, package.open(info, "w") as dest:
                        shutil.copyfileobj(src, dest)
            os.replace(artifact, output)
        finally:
            artifact.unlink(missing_ok=True)
    print(f"Built {output} ({output.stat().st_size / 1024**2:.1f} MiB)")


if __name__ == "__main__":
    version = json.loads((EDITOR / "package.json").read_bytes())["version"]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, nargs="?", default=EDITOR / "dist" / f"loadwise-{version}.vsix")
    args = parser.parse_args()
    build(args.output.resolve())
