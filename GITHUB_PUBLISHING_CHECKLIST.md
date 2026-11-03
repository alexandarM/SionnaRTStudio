# GitHub Publishing Checklist

This guide applies the prepared `alexandarM/SionnaRTStudio` fork.

## Repository identity

- Fork: https://github.com/alexandarM/SionnaRTStudio
- Upstream: https://github.com/puloktarafder/SionnaRTStudio
- Default branch: `main`
- Google Colab launcher: https://colab.research.google.com/github/alexandarM/SionnaRTStudio/blob/main/SionnaRTStudio_Colab_Launcher.ipynb

The repository is already a GitHub fork of the upstream project. Keep that repository and its Git history; do not create an unrelated repository by uploading the ZIP as a new project.

## Apply the prepared release to the existing clone

First clone your existing fork (or use your current local clone):

```bash
git clone https://github.com/alexandarM/SionnaRTStudio.git
cd SionnaRTStudio
```

Extract the prepared release ZIP into a temporary directory, then copy its project contents over the clone. The copy operation below deliberately does not replace the `.git` directory:

```bash
mkdir -p /tmp/srts-release
unzip /path/to/SionnaRTStudio_alexandarM_colab_release.zip -d /tmp/srts-release
cp -a /tmp/srts-release/SionnaRTStudio/. .
```

Review the changes before committing. The public docs and test fixtures are intentionally dataset-agnostic; do not copy private route data into the repository:



```bash
git status --short
git diff --stat
git diff --check
git diff --name-status
```

### Apache-2.0 modified-file notices

The repository-level README, `FORK_AND_ATTRIBUTION.md`, and `NOTICE` explain the fork's origin, but they do **not** replace the Apache-2.0 Section 4(b) requirement for prominent change notices in files modified from upstream. Review the `M` entries from `git diff --name-status` against the upstream fork baseline. Add a short, language-appropriate notice near the top of each modified source file, for example:

- Python / shell: `# Modified in the alexandarM/SionnaRTStudio fork; changes from upstream are maintained separately.`
- TypeScript / JavaScript / CSS: `// Modified in the alexandarM/SionnaRTStudio fork; changes from upstream are maintained separately.`
- HTML: `<!-- Modified in the alexandarM/SionnaRTStudio fork; changes from upstream are maintained separately. -->`

Do not add this statement to files that are unchanged from upstream or to new files as though they were copied-and-modified. Preserve all existing copyright and license headers. Re-run `git diff --check` after adding notices. This review is still required because an archive without the original Git baseline cannot reliably identify every changed upstream file.

Run the project checks in an environment with the required dependencies installed:

```bash
python -m compileall -q backend
python -m pytest -q backend/tests
bash -n setup.sh
bash -n run.sh
npm ci
npm run lint
npm run build
```

Then commit and push to your fork:

```bash
git add -A
git commit -m "Extend SionnaRTStudio with research workflows and Colab support"
git push origin main
```

Do not use `git push --force` for this update. Keep the existing fork history.

## Verify the Colab launcher after pushing

After the notebook is present on the `main` branch, open:

https://colab.research.google.com/github/alexandarM/SionnaRTStudio/blob/main/SionnaRTStudio_Colab_Launcher.ipynb

Run it in a fresh Colab runtime. Confirm that it clones `alexandarM/SionnaRTStudio`, reaches `/api/health`, and displays the frontend through the Colab port proxy. The optional Google Drive setting should preserve the SQLite experiment database; imported measurement datasets remain in backend memory and must be imported again after a backend restart.

## GitHub repository metadata

Suggested **About** description:

> Extended wireless digital twin platform built on NVIDIA Sionna RT, featuring 5G NR PHY simulation, field measurement validation, experiment management, and Google Colab support.

Suggested topics:

`nvidia-sionna`, `sionna-rt`, `5g-nr`, `wireless`, `ray-tracing`, `digital-twin`, `google-colab`, `field-measurements`, `radio-propagation`.

## Attribution and citation

Keep the upstream `LICENSE`, `NOTICE`, and `CITATION.cff`. The DOI and citation metadata currently in `CITATION.cff` describe Pulok Tarafder's upstream release, not this fork. When publishing a research result that depends on fork-specific changes, cite the upstream release and identify this fork using the exact commit hash or a fork-specific release tag. A separate DOI can be minted for a tagged fork release if needed.

Before public redistribution, review the applicable Apache-2.0 obligations, including preservation of the upstream license and notices and prominent notices in modified files as required by the license. This checklist is operational guidance, not legal advice.

## Test documentation

Colab acceptance guides are under `docs/testing/colab/`; the test matrix and privacy policy are in [`docs/testing/README.md`](docs/testing/README.md). Historical feature notes are under `docs/releases/` and summarized in [`CHANGELOG.md`](CHANGELOG.md).
