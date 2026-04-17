# 🗳️ Voting App Microservices

Ứng dụng bình chọn theo kiến trúc microservice, được containerize hoàn toàn bằng Docker. Người dùng vote qua giao diện web, kết quả được xử lý bất đồng bộ qua hàng đợi Redis và hiển thị real-time trên trang kết quả.

---

## 📐 Kiến trúc tổng quan

```
                    ┌──────────────┐
                    │   Browser    │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │ front-tier network      │
              │            │            │
        ┌─────▼─────┐ ┌───▼──────┐      │
        │   Vote    │ │  Result  │      │
        │ (Flask)   │ │(Express) │      │
        │ :8080     │ │ :8081    │      │
        └─────┬─────┘ └────┬─────┘      │
              │             │           │
              │ back-tier network       │
              │             │           │
        ┌─────▼─────┐ ┌────▼─────┐      │
        │   Redis   │ │ Postgres │      │
        │  (queue)  │ │  (store) │      │
        └─────┬─────┘ └────▲─────┘      │
              │             │           │
        ┌─────▼─────────────┘           │
        │   Worker  │                   │
        │   (Go)    │                   │
        └───────────┘                   │
```

### Data Flow

1. **Vote** → Người dùng bình chọn trên giao diện → Vote service đẩy vote vào **Redis queue** (`RPUSH`)
2. **Worker** → Liên tục lắng nghe Redis queue (`LPOP`), lấy vote ra và ghi/cập nhật vào **PostgreSQL** (upsert)
3. **Result** → Truy vấn PostgreSQL mỗi giây, đẩy kết quả real-time tới browser qua **Socket.IO**

---

## 🧩 Các service

### 1. Vote Service — `vote/`

| Thuộc tính | Chi tiết |
|---|---|
| **Ngôn ngữ** | Python 3.11 |
| **Framework** | Flask + Gunicorn |
| **Port** | `8080` (host) → `80` (container) |
| **Vai trò** | Giao diện bình chọn, nhận vote và đẩy vào Redis |

**Endpoints:**

| Method | Path | Mô tả |
|---|---|---|
| `GET` | `/` | Trang bình chọn |
| `POST` | `/` | Gửi vote |
| `GET` | `/health` | Health check (kiểm tra kết nối Redis) |

**Cách hoạt động:**
- Tạo `voter_id` ngẫu nhiên lưu trong cookie để định danh người vote
- Khi vote, dữ liệu `{"voter_id": "...", "vote": "a|b"}` được đẩy vào Redis list `votes`
- Production chạy bằng Gunicorn với 4 workers

**Dockerfile:** Multi-stage build với 3 stage: `base` → `dev` (watchdog) → `final` (gunicorn)

---

### 2. Result Service — `result/`

| Thuộc tính | Chi tiết |
|---|---|
| **Ngôn ngữ** | Node.js 18 |
| **Framework** | Express + Socket.IO |
| **Port** | `8081` (host) → `80` (container) |
| **Vai trò** | Hiển thị kết quả bình chọn real-time |

**Endpoints:**

| Method | Path | Mô tả |
|---|---|---|
| `GET` | `/` | Trang kết quả |
| `GET` | `/health` | Health check (kiểm tra kết nối PostgreSQL) |

**Cách hoạt động:**
- Kết nối PostgreSQL với cơ chế retry (1000 lần, mỗi lần cách 1s)
- Truy vấn `SELECT vote, COUNT(id) AS count FROM votes GROUP BY vote` mỗi giây
- Đẩy kết quả tới tất cả client qua Socket.IO event `scores`
- Sử dụng `tini` làm init process để xử lý signal đúng cách

**Dependencies chính:** `express`, `pg`, `socket.io`, `async`, `cookie-parser`

---

### 3. Worker Service — `worker/`

| Thuộc tính | Chi tiết |
|---|---|
| **Ngôn ngữ** | Go 1.22 |
| **Vai trò** | Background processor — đọc vote từ Redis, ghi vào PostgreSQL |
| **Health Port** | `8080` (container only, không expose ra host) |

**Endpoints:**

| Method | Path | Mô tả |
|---|---|---|
| `GET` | `/health` | Health check (kiểm tra kết nối Redis + PostgreSQL) |

**Cách hoạt động:**
- Chạy health check HTTP server trên goroutine riêng
- Vòng lặp chính: `LPOP` từ Redis queue `votes`
- Parse JSON vote → `INSERT ... ON CONFLICT DO UPDATE` vào PostgreSQL (upsert theo `voter_id`)
- Tự động reconnect Redis và PostgreSQL khi mất kết nối
- Tạo table `votes` tự động nếu chưa tồn tại

**Dockerfile:** Multi-stage build: `golang:1.22-alpine` (build) → `alpine:3.19` (runtime ~10MB)

---

### 4. Redis

| Thuộc tính | Chi tiết |
|---|---|
| **Image** | `redis:alpine` |
| **Vai trò** | Message queue (Redis List) giữa Vote và Worker |
| **Network** | `back-tier` only |

---

### 5. PostgreSQL

| Thuộc tính | Chi tiết |
|---|---|
| **Image** | `postgres:15-alpine` |
| **Vai trò** | Persistent storage cho kết quả vote |
| **Volume** | `db-data` (named volume) |
| **Network** | `back-tier` only |

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS votes (
    id   VARCHAR(255) NOT NULL UNIQUE,  -- voter_id
    vote VARCHAR(255) NOT NULL           -- 'a' or 'b'
);
```

---

## 🌐 Networking

| Network | Services | Mục đích |
|---|---|---|
| `front-tier` | vote, result | Expose ra browser |
| `back-tier` | vote, result, worker, redis, db | Giao tiếp nội bộ giữa các service |

> **Lưu ý:** Redis và PostgreSQL chỉ nằm trong `back-tier`, không truy cập được từ bên ngoài.

---

## ⚙️ Cấu hình (Environment Variables)

Tất cả cấu hình được quản lý tập trung trong file `.env` tại root project:

| Biến | Mặc định | Mô tả |
|---|---|---|
| `REDIS_HOST` | `redis` | Hostname của Redis |
| `REDIS_PORT` | `6379` | Port của Redis |
| `POSTGRES_HOST` | `db` | Hostname của PostgreSQL |
| `POSTGRES_PORT` | `5432` | Port của PostgreSQL |
| `POSTGRES_USER` | `postgres` | Username PostgreSQL |
| `POSTGRES_PASSWORD` | `postgres` | Password PostgreSQL |
| `POSTGRES_DB` | `postgres` | Database name |
| `OPTION_A` | `Cats` | Tên lựa chọn A |
| `OPTION_B` | `Dogs` | Tên lựa chọn B |
| `VOTE_PORT` | `80` | Port nội bộ Vote service |
| `RESULT_PORT` | `80` | Port nội bộ Result service |
| `WORKER_HEALTH_PORT` | `8080` | Port health check của Worker |

> ⚠️ File `.env` đã được thêm vào `.gitignore`. Bạn cần tạo file này trước khi chạy. Xem phần [Quick Start](#-quick-start).

---

## 🏥 Health Checks

Mỗi service đều có health check endpoint, được Docker Compose sử dụng để kiểm tra trạng thái:

| Service | Endpoint | Tool | Interval |
|---|---|---|---|
| **vote** | `http://localhost/health` | `curl` | 15s |
| **result** | `http://localhost/health` | `curl` | 15s |
| **worker** | `http://localhost:8080/health` | `wget` | 15s |
| **redis** | `redis-cli ping` | shell script | 5s |
| **db** | `pg_isready` | shell script | 5s |

**Response mẫu (thành công):**

```json
{
  "status": "ok",
  "redis": "connected",
  "postgres": "connected"
}
```

**Response mẫu (lỗi):**

```json
{
  "status": "error",
  "redis": "disconnected",
  "error": "connection refused"
}
```

---

## 🚀 Quick Start

### Yêu cầu

- [Docker](https://docs.docker.com/get-docker/) >= 20.10
- [Docker Compose](https://docs.docker.com/compose/install/) >= 2.0

### 1. Clone repository

```bash
git clone <repository-url>
cd voting-app-microservice
```

### 2. Tạo file `.env`

```bash
cat > .env << 'EOF'
# --- Redis ---
REDIS_HOST=redis
REDIS_PORT=6379

# --- PostgreSQL ---
POSTGRES_HOST=db
POSTGRES_PORT=5432
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=postgres

# --- Vote Service ---
OPTION_A=Cats
OPTION_B=Dogs
VOTE_PORT=80

# --- Result Service ---
RESULT_PORT=80

# --- Worker Service ---
WORKER_HEALTH_PORT=8080
EOF
```

### 3. Khởi chạy

```bash
# Start tất cả services
docker compose up -d

# Xem logs
docker compose logs -f

# Kiểm tra trạng thái
docker compose ps
```

### 4. Truy cập

| Service | URL |
|---|---|
| 🗳️ Trang bình chọn | [http://localhost:8080](http://localhost:8080) |
| 📊 Trang kết quả | [http://localhost:8081](http://localhost:8081) |

---

## 🛑 Dừng và dọn dẹp

```bash
# Dừng tất cả services
docker compose down

# Dừng và xóa volumes (database data)
docker compose down -v
```

---

## 📁 Cấu trúc thư mục

```
voting-app-microservice/
├── .env                        # Cấu hình môi trường (gitignored)
├── .gitignore
├── docker-compose.yml          # Orchestration definition
├── README.md
│
├── vote/                       # Vote Service (Python/Flask)
│   ├── Dockerfile              # Multi-stage: base → dev → final
│   ├── app.py                  # Flask application
│   ├── requirements.txt        # Python dependencies
│   ├── templates/
│   │   └── index.html          # Giao diện bình chọn
│   └── static/
│       └── stylesheets/        # CSS
│
├── result/                     # Result Service (Node.js/Express)
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js               # Express + Socket.IO server
│   └── views/
│       ├── index.html          # Giao diện kết quả
│       ├── app.js              # Client-side Socket.IO logic
│       ├── angular.min.js      # AngularJS (client rendering)
│       └── stylesheets/        # CSS
│
├── worker/                     # Worker Service (Go)
│   ├── Dockerfile              # Multi-stage: build → runtime
│   ├── go.mod
│   ├── go.sum
│   └── main.go                 # Main worker logic
│
└── healthchecks/               # Health check scripts cho infra
    ├── redis.sh                # redis-cli ping
    └── postgres.sh             # pg_isready
```

---

## 🔧 Development

### Rebuild một service cụ thể

```bash
docker compose build vote
docker compose up -d vote
```

### Xem logs của một service

```bash
docker compose logs -f worker
```

### Kiểm tra health check

```bash
# Vote service
curl http://localhost:8080/health

# Result service
curl http://localhost:8081/health
```

### Truy cập database trực tiếp

```bash
docker compose exec db psql -U postgres -d postgres -c "SELECT * FROM votes;"
```

### Monitor Redis queue

```bash
docker compose exec redis redis-cli LLEN votes
```

---

## 📝 Ghi chú kỹ thuật

- **Upsert pattern:** Worker sử dụng `INSERT ... ON CONFLICT DO UPDATE` — mỗi `voter_id` chỉ có 1 vote cuối cùng
- **Connection resilience:** Tất cả service đều có retry logic khi kết nối DB/Redis
- **Signal handling:** Result service sử dụng `tini` để xử lý SIGTERM đúng cách
- **Stateless services:** Vote và Result service hoàn toàn stateless, có thể scale horizontal
- **Slim images:** Tất cả Dockerfile sử dụng base image `-slim` hoặc `-alpine` để giảm kích thước
