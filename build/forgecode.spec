# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for Forge Code — Windows onedir app."""

from pathlib import Path

from PyInstaller.building.api import COLLECT
from PyInstaller.building.api import EXE
from PyInstaller.building.api import PYZ
from PyInstaller.building.build_main import Analysis
from PyInstaller.building.splash import Splash
from PyInstaller.utils.hooks import collect_all
from PyInstaller.utils.hooks import collect_dynamic_libs

ROOT = Path(SPECPATH).resolve().parent
WEB = ROOT / "web"
ICON = WEB / "assets" / "forge-code.ico"
SPLASH_IMG = WEB / "assets" / "splash.png"
VERSION = ROOT / "build" / "file_version_info.txt"
RTHOOK = ROOT / "build" / "rthook_fc.py"

datas = [(str(WEB), "web")]
binaries = []
hiddenimports = [
    "paths",
    "backend",
    "term",
    "guard",
    "piton",
    "piton_jobs",
    "pitonkit",
    "winpty",
    "webview",
    "webview.platforms.winforms",
    "webview.platforms.edgechromium",
    "clr",
    "pythonnet",
    "bottle",
    "proxy_tools",
    "g4f",
]

for pkg in ("winpty", "webview", "pythonnet", "clr_loader", "pitonkit", "g4f"):
    try:
        pkg_datas, pkg_binaries, pkg_hidden = collect_all(pkg)
        datas += pkg_datas
        binaries += pkg_binaries
        hiddenimports += pkg_hidden
    except Exception:
        pass

binaries += collect_dynamic_libs("winpty")


def _keep(entry) -> bool:
    src = str(entry[0]).replace("\\", "/").lower()
    skip = (
        "/tests/",
        "/test/",
        "/android/",
        "/platforms/qt",
        "/platforms/gtk",
        "/platforms/cocoa",
        "/platforms/cef",
        "/g4f/gui/",
    )
    return not any(token in src for token in skip)


datas = [item for item in datas if _keep(item)]
binaries = [item for item in binaries if _keep(item)]

a = Analysis(
    [str(ROOT / "app.py")],
    pathex=[str(ROOT), str(ROOT / "pitonkit-lib" / "src")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[str(RTHOOK)],
    excludes=[
        "webview.platforms.android",
        "webview.platforms.qt",
        "webview.platforms.gtk",
        "webview.platforms.cocoa",
        "webview.platforms.cef",
        "tkinter.test",
        "unittest",
        "pytest",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

splash = Splash(
    str(SPLASH_IMG),
    binaries=a.binaries,
    datas=a.datas,
    text_pos=None,
    text_size=12,
    minify_script=True,
    always_on_top=True,
)

exe = EXE(
    pyz,
    a.scripts,
    splash,
    [],
    exclude_binaries=True,
    name="ForgeCode",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ICON) if ICON.exists() else None,
    version=str(VERSION) if VERSION.exists() else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    splash.binaries,
    name="ForgeCode",
)
