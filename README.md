# node.js template

[![check](https://trev.zip/template/node/actions/workflows/check.yaml/badge.svg?branch=main&logo=forgejo&logoColor=%23bac2de&label=check&labelColor=%23313244)](https://trev.zip/template/node/actions?workflow=check.yaml)
[![vulnerable](https://trev.zip/template/node/actions/workflows/vulnerable.yaml/badge.svg?branch=main&logo=forgejo&logoColor=%23bac2de&label=vulnerable&labelColor=%23313244)](https://trev.zip/template/node/actions?workflow=vulnerable.yaml)
[![node](https://img.shields.io/badge/dynamic/json?url=https://trev.zip/template/node/raw/branch/main/package.json&query=%24.engines.node&logo=nodedotjs&logoColor=%23bac2de&label=version&labelColor=%23313244&color=%23339933)](https://nodejs.org/en/about/previous-releases)

template for starting [node.js](https://nodejs.org) projects

part of [spotdemo4/templates](https://github.com/spotdemo4/templates)

## requirements

- [nix](https://nixos.org/)

## getting started

```sh
nix develop && npm install
```

### run

```sh
nix run .#dev
```

### format

```sh
nix fmt
```

### check

```sh
nix flake check
```

### build

```sh
nix build
```

### release

```sh
bumper
```

releases are automatically created for [significant](https://www.conventionalcommits.org/en/v1.0.0/#summary) changes

## use

### npm

```sh
NPM_CONFIG_REGISTRY=https://trev.zip/api/packages/template/npm/ \
    npx node-template
```

### docker

```sh
docker run trev.zip/template/node:latest
```

### nix

```sh
nix run git+https://trev.zip/template/node.git
```

### action

```yaml
- uses: spotdemo4/node-template@main
```

### download

https://trev.zip/template/node/releases
