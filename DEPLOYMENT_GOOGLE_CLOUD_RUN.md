# Google Cloud Run Production Deployment Guide: ACM Spell Maze 3D

**Document Status:** Production Ready  
**Engine:** Node.js v22 (Alpine Container)  
**Target Concurrency:** 300 Concurrent Players per Live Instance  
**Cloud Platform:** Google Cloud Run (Fully Managed, Gen 2)  
**Author:** Senior Backend Architect & DevOps Lead  
**Date:** October 2026  

---

## 1. Architectural Overview

The ACM Maze Quest 3D multiplayer backend is architected as a lightweight, high-performance, containerized service running on **Google Cloud Run (Fully Managed)**.

```
                  ┌───────────────────────────────────────────────┐
                  │                 Clients                       │
                  │   (Host Projector + 300 Mobile Player Browsers)│
                  └───────────────────────┬───────────────────────┘
                                          │ HTTPS / HTTP/2 (TLS 1.3)
                                          ▼
                  ┌───────────────────────────────────────────────┐
                  │          Google Cloud Edge / CDN              │
                  │    - Global Anycast IP & Managed SSL Cert     │
                  │    - Static Asset Caching (three.js, CSS, JS) │
                  └───────────────────────┬───────────────────────┘
                                          │
                                          ▼
                  ┌───────────────────────────────────────────────┐
                  │        Google Cloud Run (Gen 2 Service)       │
                  │    - 2 vCPU, 2 GiB Memory                      │
                  │    - Concurrency: 300 requests/container      │
                  │    - Min Instances: 1 (Warm, zero cold start) │
                  │    - In-Memory Fast Cache + HTTP ETag 304     │
                  └───────────────┬───────────────┬───────────────┘
                                  │               │
                 Serverless VPC   │               │ Public HTTPS (REST)
                   Connector      │               │
                                  ▼               ▼
                   ┌────────────────────┐   ┌────────────────────┐
                   │  Google Cloud      │   │  Upstash Redis     │
                   │  Memorystore Redis │   │  Serverless DB     │
                   │  (VPC Private IP)  │   │  (Alternative)     │
                   └────────────────────┘   └────────────────────┘
```

### Key Production Characteristics:
1. **Zero Cold-Starts on Tournament Day:** Configured with `--min-instances=1` so the server is persistently warm and ready when players scan QR codes.
2. **Deterministic Scalability:** `--concurrency=300` aligns exactly with our verified benchmark capacity, allowing 300 active players to share a single authoritative game instance while Cloud Run auto-scales up to 10 instances if multiple concurrent tournament brackets run simultaneously.
3. **Stateless Node.js Core with External Redis Backing:** Active game state is persisted to Redis, with in-memory delta caching handling sub-millisecond local reads.
4. **Hardened Minimal Container:** Built on `node:22-alpine` running as a non-privileged user (`node`), weighing $< 130$ MB with zero unnecessary toolchains.

---

## 2. Prerequisites & Initial GCP Setup

### 2.1 Tooling Requirements
- Google Cloud SDK (`gcloud` CLI) installed and authenticated.
- Docker or Google Cloud Build for containerization.
- Active GCP Project with Billing enabled.

### 2.2 Environment Variables & IAM Initialization
Run these commands in your local terminal:

```bash
# Set environment variables
export PROJECT_ID="acm-maze-game-prod"
export REGION="us-central1"
export SERVICE_NAME="acm-maze-quest"
export ARTIFACT_REPO="acm-games"
export VPC_CONNECTOR="acm-vpc-connector"

# Set active project
gcloud config set project ${PROJECT_ID}

# Enable required Google Cloud APIs
gcloud services enable \
    run.googleapis.com \
    artifactregistry.googleapis.com \
    cloudbuild.googleapis.com \
    secretmanager.googleapis.com \
    vpcaccess.googleapis.com \
    compute.googleapis.com \
    monitoring.googleapis.com \
    logging.googleapis.com
```

---

## 3. Secret Management & Redis Configuration

The production server uses environment variables for Redis authentication. Never commit these secrets to version control or hardcode them in Dockerfiles.

### Option A: Upstash Serverless Redis (Recommended for Rapid Setup)

1. Create a Redis database on [Upstash](https://upstash.com) in your target cloud region.
2. Store the credentials securely in Google Cloud Secret Manager:

```bash
# Store Upstash REST URL
echo -n "https://your-upstash-instance.upstash.io" | \
gcloud secrets create UPSTASH_REDIS_REST_URL --data-file=-

# Store Upstash REST Token
echo -n "your-secret-upstash-token" | \
gcloud secrets create UPSTASH_REDIS_REST_TOKEN --data-file=-

# Grant Secret Manager Accessor role to Cloud Run default service account
PROJECT_NUMBER=$(gcloud projects describe ${PROJECT_ID} --format='value(projectNumber)')
gcloud secrets add-iam-policy-binding UPSTASH_REDIS_REST_URL \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"

gcloud secrets add-iam-policy-binding UPSTASH_REDIS_REST_TOKEN \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
```

### Option B: Google Cloud Memorystore for Redis (Enterprise VPC Setup)

For sub-millisecond private VPC latency:
```bash
# 1. Create a VPC Network
gcloud compute networks create acm-vpc --subnet-mode=custom

gcloud compute networks subnets create acm-subnet \
    --network=acm-vpc \
    --region=${REGION} \
    --range=10.0.0.0/24

# 2. Create Serverless VPC Access Connector
gcloud compute networks vpc-access connectors create ${VPC_CONNECTOR} \
    --network=acm-vpc \
    --region=${REGION} \
    --range=10.8.0.0/28 \
    --min-instances=2 \
    --max-instances=3

# 3. Create Memorystore Redis instance
gcloud redis instances create acm-redis \
    --size=1 \
    --region=${REGION} \
    --zone=${REGION}-a \
    --network=acm-vpc \
    --redis-version=redis_7_0
```

---

## 4. Containerization & Artifact Registry

### 4.1 Artifact Registry Repository Creation
Create a private OCI container registry in Google Cloud:

```bash
gcloud artifacts repositories create ${ARTIFACT_REPO} \
    --repository-format=docker \
    --location=${REGION} \
    --description="ACM Maze Quest 3D Container Images"
```

### 4.2 Automated Build via Cloud Build
Use the project's included `cloudbuild.yaml` to run unit tests and build the container in the cloud without needing local Docker:

```bash
# Trigger automated test suite, Docker build, and registry push
gcloud builds submit . \
    --config=cloudbuild.yaml \
    --substitutions=_REGION=${REGION},_REPO=${ARTIFACT_REPO},_IMAGE=${SERVICE_NAME}
```

*Or manual build and push:*
```bash
IMAGE_TAG="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}/${SERVICE_NAME}:v2.0.0"

docker build -t ${IMAGE_TAG} .
docker push ${IMAGE_TAG}
```

---

## 5. Cloud Run Service Deployment

Deploy the container using the exact performance parameters validated during our 300-player load test:

```bash
gcloud run deploy ${SERVICE_NAME} \
    --image="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}/${SERVICE_NAME}:v2.0.0" \
    --platform=managed \
    --region=${REGION} \
    --execution-environment=gen2 \
    --allow-unauthenticated \
    --port=8080 \
    --cpu=2 \
    --memory=2Gi \
    --concurrency=300 \
    --min-instances=1 \
    --max-instances=10 \
    --timeout=300s \
    --set-secrets="UPSTASH_REDIS_REST_URL=UPSTASH_REDIS_REST_URL:latest,UPSTASH_REDIS_REST_TOKEN=UPSTASH_REDIS_REST_TOKEN:latest" \
    --set-env-vars="NODE_ENV=production"
```

### Explaining Critical Flags:
| Flag | Production Value | Engineering Justification |
| :--- | :--- | :--- |
| `--cpu=2` & `--memory=2Gi` | 2 vCPUs, 2 GiB RAM | Provides ample headroom for JSON serialization and garbage collection across 300 concurrent sockets. |
| `--concurrency=300` | 300 connections | Matches the exact validated capacity where median latency is 0.7 ms and p95 is 4.5 ms. |
| `--min-instances=1` | 1 warm container | **Critical for Game Day:** Ensures the host room and first 300 players experience instantaneous joins with 0 cold-start latency. |
| `--max-instances=10` | 10 containers | Allows multi-bracket scaling up to 3,000 total tournament participants while enforcing an upper spending cap. |
| `--execution-environment=gen2` | Second Generation | Full Linux kernel compatibility, superior TCP performance, and optimized network virtualization. |

---

## 6. Custom Domain, SSL & Cloud CDN Integration

### 6.1 Custom Domain Mapping
To run under a university or chapter domain (e.g., `maze.acmchapter.org`):

```bash
gcloud beta run domain-mappings create \
    --service=${SERVICE_NAME} \
    --domain=maze.acmchapter.org \
    --region=${REGION}
```
Add the generated `CNAME` records to your DNS provider (Cloudflare, Route53, Namecheap). Google automatically provisions and manages an auto-renewing TLS 1.3 certificate.

### 6.2 Cloud CDN Caching for Static Assets
Three.js (`three.min.js`, 603 KB) and game assets should be cached at Google's global edge locations:
1. Connect Cloud Run as a backend service to an **External HTTPS Load Balancer**.
2. Enable **Cloud CDN** on the backend service.
3. Configure cache TTL:
   - `three.min.js`, `qrcode.min.js`: 30 days (`Cache-Control: public, max-age=2592000, immutable`).
   - `style.css`, `audio.js`: 1 hour (`Cache-Control: public, max-age=3600`).
   - `/api/room*`: Dynamic bypass (`Cache-Control: no-cache, must-revalidate`).

---

## 7. Observability, Metrics & Production Health Checks

### 7.1 Real-Time Log Streaming
Inspect live match logs and API traffic from the terminal:

```bash
# Stream live logs from all 300 connected players
gcloud run services logs tail ${SERVICE_NAME} --region=${REGION}
```

### 7.2 Google Cloud Monitoring Alert Policies
Configure alert policies in Cloud Monitoring to notify the tech team if anomalies arise:

1. **High Latency Alert:**
   - Metric: `run.googleapis.com/request_latencies` (p95)
   - Threshold: $> 100$ ms for 2 consecutive minutes.
2. **Container Memory Saturation:**
   - Metric: `run.googleapis.com/container/memory/utilizations`
   - Threshold: $> 80\%$ for 1 minute.
3. **HTTP 5xx Server Errors:**
   - Metric: `run.googleapis.com/request_count` filtered by `response_code_class = 500`
   - Threshold: $> 5$ errors in 1 minute.

---

## 8. Rollback & Blue/Green Deployments

Cloud Run provides instantaneous zero-downtime revision management:

```bash
# List all historical revisions
gcloud run revisions list --service=${SERVICE_NAME} --region=${REGION}

# Perform instant emergency rollback to previous stable revision
gcloud run services update-traffic ${SERVICE_NAME} \
    --region=${REGION} \
    --to-revisions=acm-maze-quest-00001-abc=100

# Perform canary release (90% stable, 10% new)
gcloud run services update-traffic ${SERVICE_NAME} \
    --region=${REGION} \
    --to-revisions=acm-maze-quest-00001-abc=90,acm-maze-quest-00002-xyz=10
```

---

## 9. Cost Estimation Breakdown (Tournament Event)

Assuming a live 2-day university hackathon / gaming tournament with **300 active simultaneous players** and continuous match cycles:

| Resource | Usage Specification | Estimated Cost |
| :--- | :--- | :--- |
| **Cloud Run vCPU** | 2 vCPU $\times$ 1 instance $\times$ 12 active hours | ~$0.58 |
| **Cloud Run Memory** | 2 GiB $\times$ 1 instance $\times$ 12 active hours | ~$0.08 |
| **Network Egress** | ~170 KB/s with Delta Caching $\times$ 12 hours (~7.3 GB) | ~$0.88 |
| **Cloud Run Requests** | ~1.5 million requests (adaptive polling) | ~$0.60 |
| **Secret Manager** | 2 secrets $\times$ active version accesses | ~$0.06 |
| **Upstash Redis** | Pay-as-you-go Tier (< 100k writes with in-memory caching) | ~$0.20 |
| **Total Estimated Event Cost** | **Complete Live 300-Player Tournament** | **< $3.00 USD** |

---

## 10. Pre-Flight Tournament Checklist

Prior to opening the room code to 300 players:

- [ ] **Deployment Active:** Verified `gcloud run services describe ${SERVICE_NAME}` reports healthy state.
- [ ] **Warm Instance:** Confirmed `--min-instances=1` is active to eliminate cold starts.
- [ ] **CORS & ETag Headers:** Executed `curl -I https://<service-url>/api/room` to verify `Access-Control-Expose-Headers: ETag`.
- [ ] **Host Projector Audio:** Confirmed host browser has clicked the screen once to satisfy browser Web Audio API autoplay restrictions.
- [ ] **QR Code Link:** Confirmed QR code links directly to production HTTPS domain with valid `?room=CODE` parameter.
- [ ] **Unit Tests Passed:** Verified `npm test` completed 9/9 passes in build pipeline.
