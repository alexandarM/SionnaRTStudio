# Google Colab ZIP-only Launcher

The root-level [`SionnaRTStudio_Colab_Launcher_ZIP_ONLY.ipynb`](../SionnaRTStudio_Colab_Launcher_ZIP_ONLY.ipynb) is the supported entry point for development and acceptance testing in Google Colab.

## Setup

1. Open the existing ZIP-only notebook in Colab.
2. Select a GPU runtime when available (T4 or another supported NVIDIA GPU).
3. Upload exactly one complete SionnaRTStudio source ZIP. Do not upload the classroom `exported.zip` as the source archive; that is imported later through Scene Import in the running app.
4. Run all cells from top to bottom.

The notebook does not clone GitHub or run `git pull`. It extracts the uploaded ZIP, runs the project's `setup.sh`, discovers every `check:*` script from `package.json`, runs backend pytest, TypeScript checks and the Vite production build, and only then starts the backend/frontend and checks `/api/health`. New development phases add new `check:*` scripts to the source ZIP; the same notebook discovers them automatically.

## Runtime and limitations

The notebook checks the Colab Python/venv environment and available GPU. CUDA is recommended for ray tracing. CPU/LLVM fallback may be significantly slower and is not equivalent to a GPU run. Colab runtimes are temporary; the notebook does not provide persistent hosting.

Optional NR PHY dependencies remain separate from the core setup and should only be installed when PUSCH BER/BLER experiments are needed.
