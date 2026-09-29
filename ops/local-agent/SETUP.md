# Setup

VERIFAI currently standardizes on Node.js 22+ (CI and README). The current repo uses npm and TypeScript.

## Required now

- Git
- Node.js 22+
- npm
- a normal browser for manual verification

`gh` is optional but useful for issue/PR work. Docker is optional until M4.

## Arch / CachyOS

```bash
sudo pacman -S git nodejs npm
# optional
sudo pacman -S github-cli
# M4+ only
sudo pacman -S docker docker-compose
```

If Docker is needed later, enable it explicitly:

```bash
sudo systemctl enable --now docker
```

## Ubuntu / Debian

```bash
sudo apt update
sudo apt install git nodejs npm
# optional
sudo apt install gh
# M4+ only; package names vary by distro release
sudo apt install docker.io docker-compose-v2
```

## macOS

With Homebrew:

```bash
brew install git node
# optional
brew install gh
# M4+ only
brew install --cask docker
```

## Repository setup

```bash
git clone https://github.com/aditya-zig/VERIFAI.git
cd VERIFAI
npm install --no-audit --no-fund
./ops/local-agent/scripts/preflight.sh
./ops/local-agent/scripts/doctor.sh
```

Do not let bootstrap scripts run `sudo` or silently install large dependencies. Install privileged/system packages yourself.
