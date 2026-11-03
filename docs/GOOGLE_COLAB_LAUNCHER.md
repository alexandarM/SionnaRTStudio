# Google Colab Launcher

The root-level [`SionnaRTStudio_Colab_Launcher.ipynb`](../SionnaRTStudio_Colab_Launcher.ipynb) is the supported entry point for running this fork in Google Colab. The public notebook URL is [Open in Google Colab](https://colab.research.google.com/github/alexandarM/SionnaRTStudio/blob/main/SionnaRTStudio_Colab_Launcher.ipynb).

## Setup

Default repository URL: https://github.com/alexandarM/SionnaRTStudio


1. Open the notebook in Colab.
2. The notebook is preconfigured for `alexandarM/SionnaRTStudio` on `main`. Change `GITHUB_REPOSITORY` only when intentionally launching another fork, and select the corresponding branch.
3. Select a GPU runtime when available.
4. Choose whether to mount Google Drive for experiment database persistence.
5. Run all cells from top to bottom.

The launcher clones the configured fork, checks the Python virtual-environment support available in the Colab image, applies a local Python interpreter preference adjustment to `setup.sh` when needed, and runs the standard project setup. It then runs backend/frontend checks, starts `run.sh`, checks `/api/health` through the backend and Vite proxy, and displays the Colab port-proxy URL.

## Persistence

Set `ENABLE_GOOGLE_DRIVE_PERSISTENCE = True` to mount Drive and set `SIONNA_RT_STUDIO_DATA_DIR` before starting the backend. The SQLite database stores Run History and Configuration Presets. The current field-measurement dataset store is in memory, so imported files must be uploaded again after a backend or runtime restart.

## Optional NR PHY package

Set `INSTALL_OPTIONAL_PHY = True` in the first configuration cell only when PUSCH BER/BLER experiments are required. The dependency set is installed from `backend/requirements-phy.txt` and is separate from core installation.

## Limitations

Colab runtimes are temporary and may disconnect. The launcher does not turn Colab into persistent hosting, does not add application authentication, and cannot guarantee that a GPU is available in every session. CPU/LLVM fallback may be substantially slower than CUDA ray tracing.
