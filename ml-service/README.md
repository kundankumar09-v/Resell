# dupdetect v2 service (ml-service)

5-signal duplicate detection: multi-hash (pHash variants + PDQ) + SSCD
embeddings (HNSW) + identifiers (IMEI/serial) + text fusion.
Verdicts: block / review / allow. BLOCK needs 2 independent signals;
text alone never auto-blocks.

## Install (Linux, same host as the Node backend)

    git clone https://github.com/kundankumar09-v/Resell.git
    cd Resell/ml-service
    python3 -m venv .venv && source .venv/bin/activate
    pip install torch --index-url https://download.pytorch.org/whl/cpu
    pip install -r requirements.txt

(if pdqhash fails to build:  sudo apt install -y build-essential  and retry)

## Run

    cd pipeline
    uvicorn dupdetect.api:app --host 127.0.0.1 --port 8100

- keep a single worker: the vector index + tombstones live in process memory
- first start downloads SSCD weights once (~100 MB), then cached
- check:  curl -s http://127.0.0.1:8100/health

Endpoints: GET /health | POST /dup/add | POST /dup/query | POST /dup/delete

## systemd (optional)

    # /etc/systemd/system/dupdetect.service
    [Unit]
    Description=dupdetect v2
    After=network.target

    [Service]
    WorkingDirectory=/opt/Resell/ml-service/pipeline
    ExecStart=/opt/Resell/ml-service/.venv/bin/uvicorn dupdetect.api:app --host 127.0.0.1 --port 8100
    Restart=always
    RestartSec=3

    [Install]
    WantedBy=multi-user.target

    sudo systemctl daemon-reload && sudo systemctl enable --now dupdetect

## Backend wiring (shadow mode)

backend/.env (defaults already in backend/.env.example):

    DUPDETECT_SERVICE_URL=http://localhost:8100
    DUPDETECT_SHADOW=true
    DUPDETECT_TIMEOUT_MS=15000

Worker logs verdicts as [DupClient][SHADOW] next to the legacy decision.
After a monitoring period with acceptable agreement, wire the enforce
branch and set DUPDETECT_SHADOW=false.

## Known limits (fine for the shadow phase)

- store is in-memory: a service restart clears registrations
  (new listings re-register automatically; older ones do not)
- no auth on the API: keep it on 127.0.0.1 / a private network
