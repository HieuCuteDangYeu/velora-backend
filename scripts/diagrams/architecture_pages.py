#!/usr/bin/env python3
"""Hand-laid-out architecture pages (01, 02, 02a-02e) of the Velora draw.io suite.

Run after build_and_modernize_all_diagrams.py and before export_drawio_figures.py:
    python3 scripts/diagrams/architecture_pages.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from drawio_kit import Page, ev, mev, install  # noqa: E402


def page_01():
    p = Page('01-microservices-architecture', '01 · Velora high-level architecture', 1900, 1560,
             'The whole system on one page · the phone app, the edge, the two entry services, the message bus, the services that own their data, and the outside providers',
             scope='Velora-Mobile plus the backend containers in docker-compose.yml and the managed providers they call; call and notification services are outside the design')
    BX, BW = 215, 1470  # bus x and width

    def bus_x(x):
        return (x - BX) / BW

    # ---- clients and edge -------------------------------------------------------------
    p.actor('users', 70, 130, 40, 80, 'Users')
    p.phone('mobile', 215, 110, 70, 120, 'Velora-Mobile', None,
            [mev('package.json', r'"expo-video"'), mev('src/api/client.ts', None, 40)])
    p.text('Velora-Mobile', 160, 234, 180, 20, size=13, bold=True, align='center')
    p.text('Expo · React Native · Android + iOS', 130, 252, 240, 18, size=11, color='#475569', align='center')
    p.cloud('cloudflare', 420, 125, 210, 100, 'Cloudflare', 'tunnel (cloudflared) · CDN',
            [ev('docs/rate-limiting-and-guardrails.md', r'Production topology')])
    p.service('nginx', 740, 140, 200, 80, 'Nginx', 'reverse proxy · WebSocket upgrade', 'edge', [ev('infra/nginx/nginx.conf', r'upstream api_gateway')])
    p.edge('users', 'mobile', 'uses', 'link', exit=(1, 0.5), entry=(0, 0.5))
    p.edge('mobile', 'cloudflare', 'HTTPS · WSS', 'sync', exit=(1, 0.5), entry=(0.07, 0.5))
    p.edge('cloudflare', 'nginx', 'tunnel', 'sync', exit=(0.93, 0.5), entry=(0, 0.5))

    # ---- entry services ---------------------------------------------------------------
    p.zone('z-entry', BX, 300, 845, 230, 'Entry services · the only containers the phone talks to', 'api')
    p.service('gateway', 245, 345, 200, 80, 'API Gateway', 'REST · login check · rate limits\ninput validation', 'api',
              [ev('apps/api-gateway/src/api-gateway.module.ts', r'ClientsModule\.registerAsync')])
    p.store('redis-rl', 255, 450, 100, 60, 'Redis', 'rate limits', [ev('apps/api-gateway/src/api-gateway.module.ts', r'createRateLimitRedis')])
    p.service('conversation', 700, 345, 220, 80, 'Conversation Service', 'AI agent chat · shared Reels\nSocket.IO · messages', 'realtime',
              [ev('apps/conversation-service/src/conversation-service.module.ts', r'@Module')])
    p.store('mongo', 710, 450, 110, 60, 'MongoDB', 'replica set rs0', [ev('docker-compose.yml', r'image: mongo:8\.0')])
    p.edge('nginx', 'gateway', 'REST', 'sync', exit=(0.2, 1), entry=(0.5, 0), points=[(780, 270), (345, 270)])
    p.edge('nginx', 'conversation', 'Socket.IO', 'sync', exit=(0.6, 1), entry=(0.5, 0), points=[(860, 270), (810, 270)])
    for a, b2 in [('gateway', 'redis-rl'), ('conversation', 'mongo')]:
        p.edge(a, b2, '', 'data', exit=(0.1, 1), entry=(0.5, 0))

    # ---- RabbitMQ bus -----------------------------------------------------------------
    p.queue('bus', BX, 575, BW, 60, 'RabbitMQ', 'every call between services · domain events · durable Reel media and index queues with retries and dead-letter queues',
            [ev('docker-compose.yml', r'image: rabbitmq:3\.13'), ev('apps/api-gateway/src/api-gateway.module.ts', r'user_queue')])
    p.edge('gateway', 'bus', 'RPC', 'async', exit=(0.85, 1), entry=(bus_x(415), 0))
    p.edge('conversation', 'bus', 'AI request · events', 'async', exit=(0.85, 1), entry=(bus_x(900), 0))

    # ---- identity and social ----------------------------------------------------------
    p.zone('z-id', BX, 680, 1085, 370, 'Identity and social', 'domain')
    svc = [('auth', 245, 'Auth Service', 'accounts · sessions · roles\nGoogle sign-in', 'apps/auth-service/src/auth-service.module.ts'),
           ('user', 510, 'User Service', 'profiles · discovery', 'apps/user-service/src/user-service.module.ts'),
           ('friend', 775, 'Friend Service', 'requests · friends · blocks', 'apps/friend-service/src/friend-service.module.ts'),
           ('mail', 1040, 'Mail Service', 'confirmation · reset mail', 'apps/mail-service/src/mail-service.module.ts')]
    for sid, x, title, detail, file in svc:
        p.service(sid, x, 725, 235, 85, title, detail, 'domain', [ev(file, r'@Module')])
    for sid, db, x, detail, file, var in [('auth', 'auth-db', 255, 'auth DB · homelab', 'auth', 'AUTH_DATABASE_URL'), ('user', 'user-db', 520, 'user DB · Aiven', 'user', 'USER_DATABASE_URL'),
                                          ('friend', 'friend-db', 785, 'friend DB · Aiven', 'friend', 'FRIEND_DATABASE_URL')]:
        p.store(db, x, 845, 130, 70, 'PostgreSQL', detail, [ev(f'apps/{file}-service/prisma/schema.prisma', var)])
        p.edge(sid, db, '', 'data', exit=(0.2, 1), entry=(0.5, 0))
    for sid, x, lane in [('auth', 245, 362), ('user', 510, 627), ('friend', 775, 892), ('mail', 1040, 1157)]:
        p.edge('bus', sid, '', 'async', exit=(bus_x(lane), 1), entry=((lane - x) / 235, 0))
    p.cloud('google', 335, 960, 130, 80, 'Google', 'sign-in identity', [ev('apps/auth-service/src/application/use-cases/verify-google-token.use-case.ts', None, 30)])
    p.cloud('resend', 1090, 960, 140, 80, 'Resend', 'transactional email', [ev('apps/mail-service/src/infrastructure/adapters/resend.adapter.ts', None, 30)])
    p.edge('auth', 'google', 'OAuth', 'external', exit=(0.66, 1), entry=(0.5, 0))
    p.edge('mail', 'resend', 'API', 'external', exit=(0.5, 1), entry=(0.5, 0))

    # ---- operations --------------------------------------------------------------------
    p.zone('z-ops', 1320, 680, 365, 370, 'Operations', 'ops')
    p.service('monitoring', 1345, 725, 150, 85, 'Monitoring Service', 'metrics · logs · hosts API', 'ops', [ev('apps/monitoring-service/src/monitoring-service.module.ts', r'@Module')])
    p.service('prom', 1515, 725, 150, 85, 'Prometheus', 'scrape · alert rules', 'ops', [ev('docker-compose.yml', r'image: prom/prometheus')])
    p.service('alloy', 1345, 860, 150, 80, 'Alloy → Loki', 'container logs · 72 h', 'ops', [ev('docker-compose.yml', r'image: grafana/alloy'), ev('infra/loki-node/README.md', None, 12)])
    p.service('grafana', 1515, 860, 150, 80, 'Grafana', 'dashboards', 'ops', [ev('infra/grafana-node/README.md', None, 20)])
    p.edge('bus', 'monitoring', '', 'async', exit=(bus_x(1420), 1), entry=(0.5, 0))
    p.edge('monitoring', 'prom', '', 'ops', exit=(1, 0.5), entry=(0, 0.5))
    p.edge('prom', 'grafana', '', 'ops', exit=(0.5, 1), entry=(0.5, 0))
    p.edge('alloy', 'grafana', '', 'ops', exit=(1, 0.5), entry=(0, 0.5))

    # ---- content, media, search and AI -------------------------------------------------
    p.zone('z-core', BX, 1100, 1235, 420, 'Content, media, search and AI', 'processing')
    core = [('content', 245, 'Content Service', 'reels · series · shares · feed\nsubtitles · outbox', 'api', 'apps/content-service/src/content-service.module.ts'),
            ('media', 445, 'Media Service', 'presigned upload URLs\nupload lease', 'processing', 'apps/media-service/src/media-service.module.ts'),
            ('processing', 645, 'Media Processing', 'FFmpeg HLS · evidence jobs\nshort + long workers', 'processing', 'apps/media-processing-service/src/media-processing-service.module.ts'),
            ('indexing', 845, 'Reel Indexing', 'semantic index · Qdrant\nshort + long workers', 'ai', 'apps/reel-indexing-service/src/reel-indexing-service.module.ts'),
            ('tei', 1045, 'TEI runtime', 'bge-m3 embeddings\ncross-encoder rerank', 'ai', None),
            ('ai', 1245, 'AI Service', 'RAG · memory · guardrails\nmodel adapters', 'ai', 'apps/ai-service/src/ai-service.module.ts')]
    for sid, x, title, detail, role, file in core:
        evidence = [ev(file, r'@Module')] if file else [ev('docker-compose.yml', r'rag-embedding:'), ev('docker-compose.yml', r'rag-reranker:')]
        p.service(sid, x, 1150, 180, 90, title, detail, role, evidence)
    for sid, x, lane in [('content', 245, 200), ('media', 445, 495), ('processing', 645, 760), ('indexing', 845, 1025), ('ai', 1245, 1305)]:
        entry = ((lane - x) / 180, 0) if x <= lane <= x + 180 else (0.5, 0)
        mid = 1075
        pts = [(lane, mid), (x + entry[0] * 180, mid)] if lane != x + entry[0] * 180 else []
        p.edge('bus', sid, '', 'async', exit=(bus_x(lane), 1), entry=entry, points=pts)
    p.store('content-db', 245, 1290, 100, 70, 'PostgreSQL', 'content DB · homelab', [ev('apps/content-service/prisma/schema.prisma', r'CONTENT_DATABASE_URL')])
    p.store('content-redis', 360, 1290, 90, 70, 'Redis', 'feed caches', [ev('apps/content-service/src/infrastructure/repositories/redis-recommendation-feed-cache.repository.ts', r'Redis')])
    p.bucket('r2', 520, 1290, 80, 70, 'Cloudflare R2', 'media · evidence', [ev('apps/media-service/src/infrastructure/services/s3.service.ts', r'S3Client')])
    p.store('index-db', 845, 1290, 110, 70, 'PostgreSQL', 'index DB · pgvector', [ev('docker-compose.qdrant.yml', r'reel-indexing-postgres:')])
    p.store('qdrant', 975, 1290, 90, 70, 'Qdrant', 'vectors', [ev('docker-compose.yml', r'image: qdrant/qdrant')])
    p.store('ai-db', 1245, 1290, 120, 70, 'PostgreSQL', 'AI DB · pgvector · Aiven', [ev('apps/ai-service/prisma/schema.prisma', r'AI_DATABASE_URL')])
    p.edge('content', 'content-db', '', 'data', exit=(0.2, 1), entry=(0.5, 0))
    p.edge('content', 'content-redis', '', 'data', exit=(0.55, 1), entry=(0.5, 0))
    p.edge('media', 'r2', '', 'data', exit=(0.5, 1), entry=(0.5, 0))
    p.edge('processing', 'r2', '', 'data', exit=(0.2, 1), entry=(1, 0.3), points=[(681, 1311)])
    p.edge('indexing', 'index-db', '', 'data', exit=(0.2, 1), entry=(0.5, 0))
    p.edge('indexing', 'qdrant', '', 'data', exit=(0.55, 1), entry=(0.5, 0))
    p.edge('ai', 'ai-db', '', 'data', exit=(0.3, 1), entry=(0.5, 0))
    p.edge('ai', 'tei', 'HTTP', 'sync', exit=(0, 0.5), entry=(1, 0.5))
    p.edge('indexing', 'tei', 'HTTP', 'sync', exit=(1, 0.5), entry=(0, 0.5))
    p.cloud('tiktok', 700, 1390, 160, 80, 'TikTok CDN', 'optional HLS mirror', [ev('apps/media-processing-service/src/infrastructure/services/tiktok-cdn.service.ts', None, 30)])
    p.edge('processing', 'tiktok', '', 'external', exit=(0.85, 1), entry=(0.5, 0))
    p.edge('indexing', 'r2', '', 'data', exit=(0, 0.75), entry=(1, 0.8), points=[(826, 1217), (826, 1346)])

    # ---- model providers -----------------------------------------------------------------
    p.zone('z-models', 1480, 1100, 205, 420, 'Model providers', 'external')
    p.cloud('groqcf', 1495, 1150, 175, 85, 'Groq · Cloudflare AI', 'Whisper ASR · vision', [ev('apps/ai-service/src/infrastructure/adapters/groq-vision.adapter.ts', None, 30), ev('apps/ai-service/src/infrastructure/adapters/cloudflare-vision.adapter.ts', None, 30)])
    p.cloud('ollama', 1495, 1270, 175, 85, 'Ollama · Muse', 'Gemma text roles · gateway', [ev('apps/ai-service/src/infrastructure/adapters/hybrid-structured-llm.adapter.ts', r'class HybridStructuredLlmAdapter', 40)])
    p.cloud('langfuse', 1495, 1390, 175, 85, 'Langfuse', 'AI traces · scores', [ev('apps/ai-service/src/infrastructure/services/langfuse-tracing.service.ts', None, 30)])
    p.edge('ai', 'groqcf', '', 'external', exit=(1, 0.2), entry=(0, 0.5), points=[(1415, 1168), (1415, 1192)])
    p.edge('ai', 'ollama', '', 'external', exit=(1, 0.5), entry=(0, 0.5), points=[(1440, 1195), (1440, 1312)])
    p.edge('ai', 'langfuse', '', 'external', exit=(1, 0.8), entry=(0, 0.5), points=[(1465, 1222), (1465, 1432)])

    p.edge('mobile', 'r2', 'HLS GET · original PUT', 'external', exit=(0, 0.85), entry=(0, 0.5), points=[(150, 212), (150, 1405), (485, 1405), (485, 1325)])
    p.legend(1110, 300, [('sync', 'Direct request'), ('async', 'Message over RabbitMQ'), ('data', 'Reads and writes its own data'),
                         ('external', 'Outside provider or direct-to-storage'), ('ops', 'Metrics and logs')])
    p.text('Reading guide: every service owns its data and never reads another service\'s store. Services talk to each other only through RabbitMQ. Videos go straight between the phone and storage, never through the gateway.', 215, 1530, 1470, 20, size=11, color='#475569')
    return p.element()


def page_02():
    p = Page('02-application-architecture', '02 · Service communication and durable job topology', 1900, 1480,
             'Who consumes which RabbitMQ queue, who calls whom, and how the Reel media and index jobs flow with retries and dead letters',
             scope='docker-compose.yml services, Nest ClientsModule registrations, libs/common reel queue constants')
    p.zone('z-rpc', 40, 100, 1820, 470, 'Who calls whom · every call between services goes through RabbitMQ (ClientProxy.send / emit)', 'messaging')
    svc = [
        ('gateway', 'API Gateway', 'HTTP :3000', 'user · auth · media · conversation · content · ai · friend · monitoring', 'api', 'apps/api-gateway/src/api-gateway.module.ts', r'ClientsModule\.registerAsync'),
        ('auth', 'Auth Service', 'auth_queue', 'user · mail', 'domain', 'apps/auth-service/src/auth-service.module.ts', r'MAIL_SERVICE_CLIENT'),
        ('user', 'User Service', 'user_queue', 'auth · friend · monitoring', 'domain', 'apps/user-service/src/user-service.module.ts', r'@Module'),
        ('friend', 'Friend Service', 'friend_queue', 'user · conversation', 'domain', 'apps/friend-service/src/friend-service.module.ts', r'CONVERSATION_SERVICE_RMQ'),
        ('mail', 'Mail Service', 'mail_queue', '(no outgoing RPC) · Resend API', 'domain', 'apps/mail-service/src/mail-service.module.ts', r'@Module'),
        ('content', 'Content Service', 'content_queue', 'ai · conversation · friend · index · user · monitoring', 'api', 'apps/content-service/src/content-service.module.ts', r'@Module'),
        ('conversation', 'Conversation Service', 'conversation_queue', 'ai · auth · media · user', 'realtime', 'apps/conversation-service/src/conversation-service.module.ts', r'AI_SERVICE_RMQ'),
        ('ai', 'AI Service', 'ai_queue', 'content · conversation · index · monitoring', 'ai', 'apps/ai-service/src/ai-service.module.ts', r'CONTENT_RMQ'),
        ('media', 'Media Service', 'media_queue', 'content · media-processing', 'processing', 'apps/media-service/src/media-service.module.ts', r'MEDIA_PROCESSING_RMQ'),
        ('processing', 'Media Processing', 'reel media queues · processing_queue', 'content · conversation · monitoring', 'processing', 'apps/media-processing-service/src/main.ts', r'getEvidenceQueuesForWorkerLane'),
        ('indexing', 'Reel Indexing', 'reel index queues · query queue', 'ai · content · monitoring', 'ai', 'apps/reel-indexing-service/src/main.ts', r'REEL_INDEX_QUERY_QUEUE'),
        ('monitoring', 'Monitoring Service', 'monitoring_queue · HTTP', 'content · Prometheus · Loki', 'ops', 'apps/monitoring-service/src/monitoring-service.module.ts', r'CONTENT_SERVICE_RMQ'),
    ]
    for i, (sid, title, consumes, calls, role, file, pattern) in enumerate(svc):
        col, row = i % 5, i // 5
        x, y = 70 + col * 360, 150 + row * 135
        detail = f'consumes  {consumes}\ncalls  {calls}'
        p.service(sid, x, y, 330, 112, title, detail, role, [ev(file, pattern)])
    p.text('Request / reply calls use ClientProxy.send; fire-and-forget domain events use emit. The durable Reel pipelines below use direct AMQP exchanges with manual ack instead.', 70, 540, 1700, 20, size=11, color='#475569')

    # ---- durable job topology ------------------------------------------------------------
    def lane(y0, title, exch, prefix, publisher, publisher_detail, worker_names, queues, retries, dlq, completion, role_ev):
        p.zone(f'z-{prefix}', 40, y0, 1820, 385, title, 'messaging')
        p.service(f'{prefix}-pub', 70, y0 + 135, 210, 100, publisher, publisher_detail, 'api', [role_ev['pub']])
        p.exchange(f'{prefix}-ex', 330, y0 + 140, 200, 90, exch, 'direct exchange', [role_ev['ex']])
        p.edge(f'{prefix}-pub', f'{prefix}-ex', 'publish\n(persistent)', 'async', exit=(1, 0.5), entry=(0, 0.5))
        y = y0 + 55
        for i, (qid, qname, qdetail) in enumerate(queues):
            p.qbox(f'{prefix}-{qid}', 600, y + i * 62, 300, 50, qname, qdetail, [role_ev['q']])
            p.edge(f'{prefix}-ex', f'{prefix}-{qid}', '', 'async', exit=(1, 0.5), entry=(0, 0.5))
        for i, (wid, wtitle, wdetail, srcs) in enumerate(worker_names):
            wy = y0 + 75 + i * 150
            p.service(f'{prefix}-{wid}', 1010, wy, 250, 100, wtitle, wdetail, 'processing' if prefix == 'media' else 'ai', [role_ev['w']])
            for src in srcs:
                p.edge(f'{prefix}-{src}', f'{prefix}-{wid}', '', 'async', exit=(1, 0.5), entry=(0, 0.5))
        p.qbox(f'{prefix}-retry', 1380, y0 + 55, 440, 70, retries[0], retries[1], [role_ev['r']], dashed=True)
        p.qbox(f'{prefix}-dlq', 1380, y0 + 165, 440, 70, dlq[0], dlq[1], [role_ev['d']])
        p.text(completion, 1380, y0 + 262, 440, 100, size=11, color='#475569')
        p.edge(f'{prefix}-' + worker_names[0][0], f'{prefix}-retry', 'transient failure', 'async', exit=(1, 0.3), entry=(0, 0.5), points=[(1320, y0 + 105), (1320, y0 + 90)])
        p.edge(f'{prefix}-' + worker_names[0][0], f'{prefix}-dlq', 'attempts exhausted', 'async', exit=(1, 0.7), entry=(0, 0.5), points=[(1330, y0 + 145), (1330, y0 + 200)])
        p.edge(f'{prefix}-retry', f'{prefix}-ex', 'TTL expires → back to the lane', 'async', exit=(0.5, 0), entry=(0.5, 0), points=[(1600, y0 + 30), (430, y0 + 30)])

    lane(600, 'Reel media jobs · exchange reel_media_jobs', 'reel_media_jobs', 'media', 'Content Service', 'outbox dispatcher\npublishes encode and evidence jobs',
         [('short', 'Media Processing · SHORT lane', 'media-processing-service\nencode first, then evidence jobs', ['q0', 'q2']),
          ('long', 'Media Processing · LONG lane', 'media-processing-long-service\nlong videos', ['q1', 'q3'])],
         [('q0', 'reel_media_short_jobs', 'encode · short video'), ('q1', 'reel_media_long_jobs', 'encode · long video'),
          ('q2', 'reel_media_short_evidence_jobs', 'transcript audio + frames · low priority'), ('q3', 'reel_media_long_evidence_jobs', 'transcript audio + frames · low priority')],
         ('Retry queues (TTL + dead-letter back)', 'short: 30 s → 5 min · long: 60 s → 10 min'), ('Dead-letter queues', 'reel_media_short_dlq · reel_media_long_dlq\nexchange reel_media_dead_letter'),
         'On success the worker reports the HLS output to Content over RPC; Content then queues the evidence jobs and, once evidence exists, the index job.',
         dict(pub=ev('apps/content-service/src/infrastructure/adapters/reel-media-job-publisher.adapter.ts', r'getReelMediaEvidenceQueue'), ex=ev('libs/common/src/processing/reel-media-queue.constants.ts', r'REEL_MEDIA_EXCHANGE ='),
              q=ev('libs/common/src/processing/reel-media-queue.constants.ts', r'REEL_MEDIA_QUEUE_NAMES ='), w=ev('apps/media-processing-service/src/main.ts', r'getEvidenceQueuesForWorkerLane'),
              r=ev('libs/common/src/processing/reel-media-queue.constants.ts', r'REEL_MEDIA_RETRY_QUEUES'), d=ev('libs/common/src/processing/reel-media-queue.constants.ts', r'REEL_MEDIA_DEAD_LETTER_QUEUES')))
    lane(1010, 'Reel index jobs · exchange reel_index_jobs', 'reel_index_jobs', 'index', 'Content Service', 'publishes an index job\nwhen media and evidence are ready',
         [('short', 'Reel Indexing · SHORT lane', 'reel-indexing-service\nplus the query endpoints', ['q0']),
          ('long', 'Reel Indexing · LONG lane', 'reel-indexing-long-service', ['q1'])],
         [('q0', 'reel_index_short_jobs', 'short video index'), ('q1', 'reel_index_long_jobs', 'long video index')],
         ('Retry queues (TTL + dead-letter back)', 'short: 30 s → 5 min · long: 60 s → 10 min\nquota-failed jobs rotate to the back of the lane'), ('Dead-letter queues', 'reel_index_short_dlq · reel_index_long_dlq\nexchange reel_index_dead_letter · alert on dead letters'),
         'The worker finishes an attempt by calling Content over RPC (complete indexing); search reaches the indexer through reel_index_query_queue.',
         dict(pub=ev('apps/content-service/src/infrastructure/adapters/reel-index-job-publisher.adapter.ts', r'REEL_INDEX_EXCHANGE'), ex=ev('libs/common/src/processing/reel-media-queue.constants.ts', r'REEL_INDEX_EXCHANGE ='),
              q=ev('libs/common/src/processing/reel-media-queue.constants.ts', r'REEL_INDEX_QUEUE_NAMES ='), w=ev('apps/reel-indexing-service/src/main.ts', r'getIndexQueuesForWorkerLane'),
              r=ev('libs/common/src/processing/reel-media-queue.constants.ts', r'REEL_INDEX_RETRY_QUEUES'), d=ev('libs/common/src/processing/reel-media-queue.constants.ts', r'REEL_INDEX_DEAD_LETTER_QUEUES')))
    return p.element()


def grid(p, x, y, items, cols, w, h, gx=14, gy=12):
    """Place small component boxes in a grid; items are (id, title, detail, role, evidence)."""
    for i, (nid, title, detail, role, evidence) in enumerate(items):
        p.box(nid, x + (i % cols) * (w + gx), y + (i // cols) * (h + gy), w, h, title, detail, role, evidence)


def page_02a():
    p = Page('02a-deployment-topology', '02a · Deployment topology', 1900, 1440,
             'Where each part runs today · homelab Docker Compose host, velora-node-2, a Windows standby laptop, the model-host laptop and managed providers',
             scope='docker-compose.yml, docker-compose.qdrant.yml and infra/*/README.md; hosts are connected over Tailscale')
    D = 'docker-compose.yml'
    p.actor('users', 60, 105, 36, 72, 'Users')
    p.phone('mobile', 170, 90, 56, 100, 'Velora-Mobile', None, [mev('package.json', r'"expo-video"')])
    p.text('Velora-Mobile', 130, 194, 140, 20, size=13, bold=True, align='center')
    p.cloud('cloudflare', 330, 95, 250, 105, 'Cloudflare', 'DNS · tunnel · Access · CDN', [ev('docs/rate-limiting-and-guardrails.md', r'Production topology')])
    p.edge('users', 'mobile', '', 'link', exit=(1, 0.5), entry=(0, 0.5))
    p.edge('mobile', 'cloudflare', 'HTTPS · WSS', 'sync', exit=(1, 0.5), entry=(0.07, 0.5))

    # ---- homelab ---------------------------------------------------------------------------
    p.node('homelab', 40, 250, 1200, 830, 'Homelab · Apple M1 Mac', 'Docker Compose project microservices-boilerplate · images pulled from Docker Hub · deployed by velora-deploy', [ev('scripts/deploy/velora-deploy-core', r'Velora production deployment controller')], align='right')
    p.zone('h-edge', 70, 320, 330, 120, 'Edge', 'edge')
    p.box('cloudflared', 85, 355, 140, 62, 'cloudflared', 'host process · tunnel', 'edge', [ev('docs/rate-limiting-and-guardrails.md', r'Production topology')])
    p.box('nginx', 240, 355, 140, 62, 'nginx', '127.0.0.1:80 · Socket.IO', 'edge', [ev(D, r'image: nginx:alpine')])
    p.edge('cloudflare', 'cloudflared', 'tunnel', 'sync', exit=(0.5, 1), entry=(0.5, 0), points=[(455, 280), (155, 280)])
    p.edge('cloudflared', 'nginx', '', 'sync', exit=(1, 0.5), entry=(0, 0.5))
    p.zone('h-entry', 420, 320, 790, 120, 'Entry services', 'api')
    grid(p, 435, 355, [('gateway', 'api-gateway', ':3000', 'api', [ev(D, r'api-gateway:')]), ('conv', 'conversation-service', ':3005 · Socket.IO', 'realtime', [ev(D, r'conversation-service:')])
                       ], 2, 300, 62)
    p.edge('nginx', 'gateway', '', 'sync', exit=(1, 0.2), entry=(0, 0.2), points=[(400, 367), (410, 367)])

    p.zone('h-app', 70, 460, 760, 170, 'Domain services', 'domain')
    grid(p, 85, 495, [('auth', 'auth-service', 'auth DB', 'domain', [ev(D, r'  auth-service:')]), ('user', 'user-service', 'user DB', 'domain', [ev(D, r'  user-service:')]),
                      ('friend', 'friend-service', 'friend DB', 'domain', [ev(D, r'  friend-service:')]), ('content', 'content-service', 'content DB', 'domain', [ev(D, r'  content-service:')]),
                      ('media', 'media-service', 'presign', 'domain', [ev(D, r'  media-service:')]),
                      ('monitor', 'monitoring-service', 'ops API', 'ops', [ev(D, r'  monitoring-service:')])], 4, 170, 52)
    p.zone('h-work', 850, 460, 360, 170, 'Reel workers and AI', 'processing')
    grid(p, 865, 495, [('proc', 'media-processing', 'SHORT + LONG lanes', 'processing', [ev(D, r'media-processing-long-service:')]), ('idx', 'reel-indexing', 'SHORT + LONG lanes', 'ai', [ev(D, r'reel-indexing-long-service:')]),
                       ('ai', 'ai-service', 'RAG · memory', 'ai', [ev(D, r'  ai-service:')])], 2, 160, 52)
    p.zone('h-model', 70, 650, 520, 130, 'Model runtimes (CPU / local)', 'ai')
    grid(p, 85, 685, [('tei1', 'rag-embedding', 'TEI · bge-m3', 'ai', [ev(D, r'rag-embedding:')]), ('tei2', 'rag-reranker', 'TEI · cross-encoder', 'ai', [ev(D, r'rag-reranker:')]),
                      ('ollamav', 'rag-vision', 'Ollama · profile', 'ai', [ev(D, r'rag-vision:')])], 3, 160, 62)
    p.zone('h-data', 70, 800, 920, 240, 'Stateful services', 'data')
    grid(p, 85, 835, [('rabbit', 'rabbitmq 3.13', 'queues · exchanges', 'messaging', [ev(D, r'image: rabbitmq:3\.13')]), ('redis', 'redis 8.6', 'caches · limits · registry', 'data', [ev(D, r'image: redis:8\.6')]),
                      ('mongo', 'mongo 8.0 · rs0', 'chat messages', 'data', [ev(D, r'image: mongo:8\.0')]), ('pg', 'postgres 18.6', 'auth DB · content DB', 'data', [ev(D, r'image: postgres:18\.6')]),
                      ('idxpg', 'reel-indexing-postgres', 'pgvector 0.8.7', 'data', [ev('docker-compose.qdrant.yml', r'reel-indexing-postgres:')]), ('qdrant', 'qdrant 1.20', 'vector search · TLS', 'data', [ev(D, r'image: qdrant/qdrant')])], 3, 285, 80)
    p.zone('h-ops', 1010, 800, 200, 240, 'Observability', 'ops')
    grid(p, 1025, 835, [('prom', 'prometheus', 'scrape · rules', 'ops', [ev(D, r'image: prom/prometheus')]), ('alloy', 'alloy', 'logs → Loki', 'ops', [ev(D, r'image: grafana/alloy')]), ('nodeexp', 'node-exporter', 'host metrics', 'ops', [ev(D, r'image: prom/node-exporter')])], 1, 170, 52)

    # ---- velora-node-2 ---------------------------------------------------------------------
    p.node('node2', 1430, 250, 440, 450, 'velora-node-2 · VPS, France', 'tailnet 100.86.68.16 · public IPv4', [ev('infra/mongo-replica/README.md', None, 12)])
    grid(p, 1450, 325, [('mail', 'mail-service', 'mail_queue · Resend', 'domain', [ev('infra/friend-mail-node/README.md', None, 14)]), ('mrep', 'mongo secondary', 'non-voting · priority 0', 'data', [ev('infra/mongo-replica/README.md', None, 14)]), ('prep', 'postgres standby', 'streaming replica', 'data', [ev('infra/postgres-replica/README.md', None, 14)]),
                        ('grafana', 'Grafana 13', 'dashboards', 'ops', [ev('infra/grafana-node/README.md', None, 14)]), ('loki', 'Loki 3.7', '72 h retention', 'ops', [ev('infra/loki-node/README.md', None, 14)]),
                        ('langfuse', 'Langfuse v4', 'AI traces · ClickHouse', 'ops', [ev('infra/langfuse-node/README.md', None, 14)]), ('backup', 'backup worker', 'nightly dumps', 'ops', [ev('infra/backup-worker/README.md', None, 14)])], 2, 195, 66, 20, 16)
    p.node('winlap', 1430, 735, 440, 175, 'Windows laptop · WSL2', 'Ubuntu 24.04 · same LAN as the homelab', [ev('infra/windows-node/README.md', None, 12)])
    grid(p, 1450, 815, [('wmongo', 'mongo secondary', 'non-voting', 'data', [ev('infra/windows-node/README.md', None, 20)]), ('wpg', 'postgres standby', 'hot standby', 'data', [ev('infra/windows-node/README.md', None, 20)]),
                        ('wagent', 'vps-agent', 'node-exporter', 'ops', [ev('infra/vps-agent/README.md', None, 14)])], 3, 128, 60, 10, 0)
    p.node('devlap', 1430, 945, 440, 160, 'Developer laptop · model host', 'GPU · reverse SSH tunnels into the homelab', [ev('docs/model-host.md', None, 12)])
    p.box('gemma', 1450, 1025, 195, 66, 'Ollama velora-gemma4', 'gemma4:e2b-it-qat', 'ai', [ev('docs/model-host.md', None, 12)])
    p.box('muse', 1660, 1025, 195, 66, 'muse2api (optional)', 'indexing text roles', 'ai', [ev('.env.example', r'AI_MUSE_ENABLED')], dashed=True)

    p.edge('homelab', 'node2', 'Tailscale\nmail queue · replication\nmetrics · logs · traces', 'async', exit=(1, 0.3), entry=(0, 0.3))
    p.edge('homelab', 'winlap', 'Tailscale\nreplication · metrics', 'data', exit=(1, 0.62), entry=(0, 0.5))
    p.edge('homelab', 'devlap', 'reverse SSH tunnels\nOllama :11435 · Muse :18611', 'external', exit=(1, 0.88), entry=(0, 0.5))

    # ---- managed providers --------------------------------------------------------------------
    p.zone('z-managed', 40, 1140, 1830, 230, 'Managed providers', 'external')
    p.store('aiven', 80, 1180, 150, 100, 'Aiven PostgreSQL', 'Singapore · user · friend · AI (pgvector)', [ev('apps/ai-service/prisma/schema.prisma', r'AI_DATABASE_URL')])
    p.bucket('r2', 290, 1185, 90, 70, 'Cloudflare R2', 'originals · HLS · evidence', [ev('apps/media-service/src/infrastructure/services/s3.service.ts', r'S3Client')])
    p.cloud('cfai', 470, 1180, 190, 95, 'Cloudflare Workers AI', 'frame analysis', [ev('apps/ai-service/src/infrastructure/adapters/cloudflare-vision.adapter.ts', None, 30)])
    p.cloud('groq', 710, 1180, 170, 95, 'Groq', 'Whisper ASR · vision fallback', [ev('apps/ai-service/src/infrastructure/adapters/groq-transcription.adapter.ts', None, 30)])
    p.cloud('resend', 930, 1180, 160, 95, 'Resend', 'transactional email', [ev('apps/mail-service/src/infrastructure/adapters/resend.adapter.ts', None, 30)])
    p.cloud('google', 1380, 1180, 150, 95, 'Google', 'sign-in identity', [ev('apps/auth-service/src/application/use-cases/verify-google-token.use-case.ts', None, 30)])
    p.cloud('tiktok', 1580, 1180, 180, 95, 'TikTok CDN', 'optional HLS mirror', [ev('apps/media-processing-service/src/infrastructure/services/tiktok-cdn.service.ts', None, 30)])
    p.edge('homelab', 'aiven', 'TLS', 'external', exit=(0.08, 1), entry=(0.5, 0))
    p.edge('homelab', 'r2', 'S3 API', 'external', exit=(0.28, 1), entry=(0.5, 0))
    p.text('Homelab services also call the model, mail, identity and CDN providers directly over HTTPS.', 470, 1295, 1290, 20, size=11, color='#475569')
    p.legend(1450, 95, [('sync', 'Client request path'), ('async', 'RabbitMQ across hosts'), ('external', 'Tunnel or provider API'), ('data', 'Replication')], title='Legend')
    return p.element()


def page_02b():
    p = Page('02b-release-pipeline', '02b · Release pipeline', 1900, 1040,
             'From a push on master to running containers · CI validates, CD builds or re-tags immutable images, the homelab controller deploys and rolls back',
             scope='.github/workflows/deploy.yml, cd.yml, docs/ci-cd-registries.md, scripts/deploy/velora-deploy-core')
    W, C = '.github/workflows/deploy.yml', '.github/workflows/cd.yml'
    p.actor('dev', 50, 120, 36, 72, 'Developer')
    p.cloud('github', 160, 110, 200, 100, 'GitHub', 'master · PR · homelab-deploy branch', [ev(W, r'^name: Homelab CI')])
    p.edge('dev', 'github', 'push · pull request', 'sync', exit=(1, 0.5), entry=(0, 0.5))
    p.zone('z-ci', 400, 90, 420, 520, 'Homelab CI · deploy.yml · every PR and master push', 'processing')
    p.box('detect', 420, 140, 380, 70, 'detect-changes', 'which application images are affected', 'processing', [ev(W, r'Detect affected application images')])
    p.box('validate', 420, 235, 380, 110, 'validate', 'compose + nginx validation · lint · unit and end-to-end tests\nAI RAG regression · Nest build · Swagger DTO check', 'processing', [ev(W, r'name: Validate Docker Compose'), ev(W, r'Build all Nest applications')])
    p.box('buildci', 420, 370, 380, 80, 'build-images (arm64, no publish)', 'proves every changed Dockerfile builds · cache read from GHCR', 'processing', [ev(W, r'Build ARM64 image without publishing')])
    p.text('Concurrency: one CI run per PR; pushes to master run independently.', 420, 470, 380, 40, size=11, color='#475569')
    p.edge('github', 'detect', '', 'sync', exit=(1, 0.5), entry=(0, 0.5), points=[(380, 160), (380, 175)])
    p.edge('detect', 'validate', '', 'sync', exit=(0.5, 1), entry=(0.5, 0))
    p.edge('validate', 'buildci', '', 'sync', exit=(0.5, 1), entry=(0.5, 0))

    p.zone('z-cd', 870, 90, 470, 700, 'Homelab CD · cd.yml · workflow_run of a green CI on master', 'api')
    p.box('prep', 890, 140, 430, 70, 'prepare-release', 'immutable target SHA · should_release · one production lock', 'api', [ev(C, r'name: Prepare immutable release')])
    p.box('arm', 890, 240, 430, 100, 'build-and-push-images (arm64)', 're-tag the previous image when the service did not change,\notherwise build once · push to Docker Hub and GHCR', 'processing', [ev(C, r'Re-tag the previous release image'), ev(C, r'Build and push ARM64 image')])
    p.box('amd', 890, 365, 430, 80, 'build-and-push-node2-images (amd64)', 'mail-service image for velora-node-2', 'processing', [ev(C, r'Build and push AMD64 image')])
    p.box('promote', 890, 470, 430, 80, 'promote-homelab', 'fast-forward push of the approved SHA to the homelab-deploy branch', 'api', [ev(C, r'Promote approved commit to homelab-deploy')])
    p.box('deploy2', 890, 575, 430, 80, 'deploy-node2', 'SSH forced command rolls out mail-service · auto-rollback if unhealthy', 'api', [ev(C, r'Roll out mail and media workers on velora-node-2')])
    p.text('A failed CD run keeps the workflow definition it started with; the fix is the next run on current master.', 890, 690, 430, 40, size=11, color='#475569')
    p.edge('buildci', 'prep', 'workflow_run · success', 'async', exit=(1, 0.5), entry=(0, 0.5), points=[(845, 410), (845, 175)])
    p.edge('prep', 'arm', '', 'sync', exit=(0.3, 1), entry=(0.3, 0))
    p.edge('prep', 'amd', '', 'sync', exit=(0, 0.5), entry=(0, 0.5), points=[(880, 175), (880, 405)])
    p.edge('arm', 'promote', '', 'sync', exit=(1, 0.8), entry=(1, 0.5), points=[(1335, 320), (1335, 510)])
    p.edge('promote', 'deploy2', '', 'sync', exit=(0.5, 1), entry=(0.5, 0))

    p.zone('z-reg', 1390, 90, 480, 270, 'Registries', 'external')
    p.store('hub', 1415, 135, 140, 90, 'Docker Hub', '<service>:<sha> · pulled by hosts', [ev('docs/ci-cd-registries.md', r'Images the homelab')], role='external')
    p.store('ghcr', 1575, 135, 140, 90, 'GHCR', 're-tag source · build cache', [ev('docs/ci-cd-registries.md', r'GHCR `ghcr')], role='external')
    p.store('ecr', 1735, 135, 115, 90, 'AWS ECR public', 'node base image', [ev('docs/ci-cd-registries.md', r'public.ecr.aws')], role='external')
    p.text('Every release image exists in both Docker Hub and GHCR; CI/CD read from GHCR so Docker Hub rate limits cannot fail a release.', 1405, 285, 450, 60, size=11, color='#475569')
    p.edge('arm', 'ghcr', 'push · read cache', 'external', exit=(1, 0.3), entry=(0.5, 1), points=[(1360, 270), (1645, 270)])
    p.edge('arm', 'hub', 'push', 'external', exit=(1, 0.15), entry=(0.5, 1), points=[(1350, 255), (1485, 255)])

    p.node('homelab', 1390, 400, 480, 270, 'Homelab · velora-deploy controller', 'runs on the Mac · loaded from the CI-approved SHA', [ev('scripts/deploy/velora-deploy-core', r'Source of truth')], align='left')
    p.box('fetch', 1415, 480, 210, 60, 'fetch homelab-deploy', 'fast-forward from the last healthy SHA', 'domain', [ev('scripts/deploy/velora-deploy-core', r'Fetching master and homelab-deploy')])
    p.box('gate', 1640, 480, 210, 60, 'safety gates', '.env hash · compose model diff · RabbitMQ · Qdrant', 'domain', [ev('scripts/deploy/velora-deploy-core', r'env drift')])
    p.box('up', 1415, 565, 210, 70, 'compose up changed services', 'pull from Docker Hub · recreate', 'domain', [ev('scripts/deploy/velora-deploy-core', r'health-check')])
    p.box('health', 1640, 565, 210, 70, 'health checks', 'HTTP · Socket.IO · queue consumers', 'domain', [ev('scripts/deploy/velora-deploy-core', r'Conversation Socket.IO')])
    p.edge('promote', 'fetch', 'homelab-deploy', 'async', exit=(1, 0.5), entry=(0, 0.5), points=[(1360, 510), (1360, 510)])
    p.edge('fetch', 'gate', '', 'sync', exit=(1, 0.5), entry=(0, 0.5))
    p.edge('gate', 'health', '', 'sync', exit=(0.5, 1), entry=(0.5, 0), points=[(1745, 550), (1745, 560)])
    p.edge('up', 'health', '', 'sync', exit=(1, 0.5), entry=(0, 0.5))
    p.edge('gate', 'up', '', 'sync', exit=(0.1, 1), entry=(0.5, 0), points=[(1436, 548), (1520, 548)])
    p.edge('hub', 'up', 'image pull', 'external', exit=(0.1, 1), entry=(0.2, 0), points=[(1429, 340), (1380, 340), (1380, 560), (1457, 560)])
    p.box('rollback', 1415, 700, 435, 60, 'automatic rollback', 'unhealthy release → restore the previous healthy snapshot · metrics velora_deployment_* to Prometheus', 'external', [ev('scripts/deploy/velora-deploy-core', r'velora_deployment_pending')])
    p.edge('health', 'rollback', 'fails', 'external', exit=(0.5, 1), entry=(0.75, 0), points=[(1745, 660), (1741, 690)])
    p.edge('deploy2', 'node2', '', 'external', exit=(1, 0.5), entry=(0, 0.5), points=[(1360, 615), (1360, 840)])
    p.node('node2', 1390, 800, 480, 130, 'velora-node-2', 'mail-service · rollout by deploy.sh · release.env tags', [ev('infra/friend-mail-node/README.md', None, 14)])
    p.legend(60, 760, [('sync', 'Pipeline step'), ('async', 'Trigger or hand-off'), ('external', 'Registry or host interaction')], title='Legend')
    return p.element()


def page_02c():
    p = Page('02c-observability-stack', '02c · Observability and operations', 1900, 940,
             'Metrics, logs, AI traces and alerts · how monitoring-service turns them into the operator dashboard',
             scope='infra/monitoring, infra/*-node READMEs, apps/monitoring-service, docker-compose.yml')
    P = 'infra/monitoring/prometheus/prometheus.yml'
    p.zone('z-targets', 40, 100, 520, 700, 'Sources', 'domain')
    p.box('svc', 60, 150, 480, 95, 'Velora services', 'monitoring-service · conversation · auth · user\nexpose /metrics · RabbitMQ metrics · reel pipeline and RAG telemetry events', 'domain', [ev(P, r'job_name: monitoring-service'), ev('apps/monitoring-service/src/infrastructure/controllers/reel-pipeline-telemetry.controller.ts', None, 30)])
    p.box('hostsrc', 60, 265, 480, 95, 'Host exporters', 'node-exporter on the homelab, velora-node-2 and the Windows laptop\nplus a read-only Docker proxy for per-container figures', 'domain', [ev(P, r'job_name: node-exporter'), ev('infra/vps-agent/README.md', None, 14)])
    p.box('probes', 60, 380, 480, 95, 'Operator probes', 'LaunchAgents on the homelab write textfile metrics:\nmodel-host probe, Muse gateway probe, deployment status', 'domain', [ev('scripts/deploy/model-host-probe', None, 14), ev('scripts/deploy/com.velora.muse-gateway-probe.plist', None, 10)])
    p.box('logsrc', 60, 500, 480, 95, 'Container logs', 'Alloy discovers Docker containers on the homelab and node-2\nlabels: service · container · host · environment', 'domain', [ev('infra/monitoring/alloy/config.alloy', r'discovery.docker')])
    p.box('aisrc', 60, 620, 480, 95, 'AI traces', 'ai-service sends observations to Langfuse\n(sampling and content capture are configuration)', 'ai', [ev('apps/ai-service/src/infrastructure/services/langfuse-tracing.service.ts', None, 30)])
    p.text('Reel indexing also exports Qdrant projection metrics checked by the reel-vector rules.', 60, 735, 480, 40, size=11, color='#475569')

    p.zone('z-store', 640, 100, 480, 700, 'Storage and alerting', 'ops')
    p.service('prom', 670, 150, 420, 325, 'Prometheus', 'scrapes every source and evaluates the alert rules\nvelora-host · rag · reel-pipeline · auth · user\nmonitoring-service · model-host\nmuse-gateway · reel-vector-projection', 'ops', [ev(P, r'job_name: prometheus'), ev('infra/monitoring/prometheus/rules/velora-monitoring.yml', r'name: velora-host')])
    p.service('loki', 670, 500, 420, 95, 'Loki · velora-node-2', '72 h retention · reached over Tailscale', 'ops', [ev('infra/loki-node/README.md', None, 14)])
    p.service('langfuse', 670, 620, 420, 95, 'Langfuse v4 · velora-node-2', 'ClickHouse · PostgreSQL · Redis · MinIO\nAPI on the tailnet · UI behind Cloudflare Access', 'ops', [ev('infra/langfuse-node/README.md', None, 14)])
    p.text('There is no Alertmanager: Prometheus evaluates the rules and monitoring-service reads the firing alerts from its API.', 670, 735, 420, 50, size=11, color='#475569')
    p.edge('svc', 'prom', 'scrape', 'ops', exit=(1, 0.5), entry=(0, 0.1))
    p.edge('hostsrc', 'prom', 'scrape', 'ops', exit=(1, 0.5), entry=(0, 0.45))
    p.edge('probes', 'prom', 'textfile', 'ops', exit=(1, 0.5), entry=(0, 0.8))
    p.edge('logsrc', 'loki', 'push', 'ops', exit=(1, 0.5), entry=(0, 0.5))
    p.edge('aisrc', 'langfuse', 'observations', 'ops', exit=(1, 0.5), entry=(0, 0.5))

    p.zone('z-consume', 1190, 100, 680, 700, 'Consumers', 'api')
    p.service('monitoring', 1220, 150, 620, 120, 'Monitoring Service', 'host registry · host metrics · container breakdown · alerts · logs\nPrometheus and Loki queries with single-flight TTL caches · telemetry controllers', 'ops', [ev('apps/monitoring-service/src/monitoring-service.module.ts', r'@Module'), ev('apps/monitoring-service/src/infrastructure/services/host-registry.service.ts', None, 20)])
    p.service('dockerproxy', 1220, 310, 300, 90, 'Docker Engine API', 'read-only proxy on each host', 'ops', [ev('apps/monitoring-service/src/infrastructure/services/docker-engine.service.ts', None, 30)])
    p.service('gateway', 1560, 310, 280, 90, 'API Gateway', '/monitoring/overview · status · hosts\ncontainers · timeseries · alerts · logs', 'api', [ev('apps/api-gateway/src/monitoring/monitoring.controller.ts', r"@Get\('overview'\)")])
    p.actor('operator', 1680, 450, 40, 70, 'Operator')
    p.service('grafana', 1220, 500, 300, 95, 'Grafana · velora-node-2', 'dashboards on Prometheus and Loki', 'ops', [ev('infra/grafana-node/README.md', None, 14)])
    p.cloud('langui', 1220, 620, 300, 95, 'Langfuse UI', 'traces · scores · benchmarks', [ev('infra/langfuse-node/README.md', r'UI')], role='ops')
    p.text('Dashboard data: hosts and containers, alerts, logs and the reel pipeline and RAG telemetry.', 1560, 600, 290, 60, size=11, color='#475569')
    p.edge('monitoring', 'prom', 'PromQL', 'ops', exit=(0, 0.3), entry=(1, 0.1))
    p.edge('monitoring', 'loki', 'LogQL', 'ops', exit=(0, 0.75), entry=(1, 0.5), points=[(1160, 240), (1160, 547)])
    p.edge('grafana', 'prom', '', 'ops', exit=(0, 0.3), entry=(1, 0.8), points=[(1140, 528), (1140, 410)])
    p.edge('grafana', 'loki', '', 'ops', exit=(0, 0.7), entry=(1, 0.8), points=[(1140, 566), (1140, 576)])
    p.edge('monitoring', 'dockerproxy', 'containers', 'ops', exit=(0.2, 1), entry=(0.5, 0))
    p.edge('gateway', 'monitoring', 'RPC monitoring_queue', 'async', exit=(0.5, 0), entry=(0.9, 1))
    p.edge('operator', 'gateway', 'REST + JWT', 'sync', exit=(0.5, 0), entry=(0.5, 1))
    p.edge('langui', 'langfuse', '', 'ops', exit=(0, 0.5), entry=(1, 0.5), points=[(1150, 667), (1150, 667)])
    p.legend(1560, 690, [('async', 'RabbitMQ RPC'), ('ops', 'Metrics · logs · traces'), ('sync', 'REST')], title='Legend')
    return p.element()


def page_02d():
    p = Page('02d-ai-model-routing', '02d · AI model and provider routing', 1900, 1180,
             'Which role of the AI Service runs on which model host, what is optional and what the fallbacks are',
             scope='apps/ai-service adapters, .env.example role settings, docs/model-host.md')
    H = 'apps/ai-service/src/infrastructure/adapters/hybrid-structured-llm.adapter.ts'
    p.zone('z-roles', 40, 100, 520, 980, 'AI Service roles', 'ai')
    roles = [('r1', 'Chat roles', 'ROUTER · RETRIEVAL_PLANNER · ANSWER\nCONTEXT_SUFFICIENCY · ANSWER_REVISION', [ev('apps/ai-service/src/infrastructure/adapters/ai-application-config.adapter.ts', r"ROUTER:")]),
             ('r2', 'Answer checking', 'VERIFIER · VERIFIER_ESCALATION\nCITATION_ATTRIBUTION · guardrail classifier (optional)', [ev('apps/ai-service/src/infrastructure/adapters/ai-application-config.adapter.ts', r"VERIFIER:")]),
             ('r3', 'Memory roles', 'CONVERSATION_SUMMARY · MEMORY_EXTRACTION', [ev('apps/ai-service/src/infrastructure/adapters/ai-application-config.adapter.ts', r"MEMORY_EXTRACTION:")]),
             ('r4', 'Indexing text roles', 'METADATA_EXTRACTION · INDEX_QUALITY\nSECTION_SUMMARY · SUBTITLE_TRANSLATION', [ev('apps/ai-service/src/infrastructure/adapters/ai-application-config.adapter.ts', r"INDEX_QUALITY:")]),
             ('r5', 'Vision', 'reel frame analysis · photo descriptions in chat', [ev('apps/ai-service/src/application/use-cases/describe-chat-images.use-case.ts', None, 30)]),
             ('r6', 'Transcription', 'reel audio manifest → transcript', [ev('apps/ai-service/src/infrastructure/adapters/groq-transcription.adapter.ts', None, 30)]),
             ('r7', 'Embeddings and rerank', 'bge-m3 query / chunk vectors · cross-encoder rerank', [ev('apps/ai-service/src/infrastructure/adapters/tei-embedding.adapter.ts', None, 30)])]
    for i, (rid, title, detail, evidence) in enumerate(roles):
        p.service(rid, 70, 150 + i * 130, 460, 100, title, detail, 'ai', evidence)

    p.zone('z-route', 640, 100, 420, 980, 'Routing in the adapters', 'messaging')
    p.box('hybrid', 665, 150, 370, 330, 'HybridStructuredLlmAdapter', 'chooses by modelRole\n1. Muse roles, when AI_MUSE_ENABLED\n2. Groq roles, when AI_GROQ_HYBRID_ENABLED\n3. otherwise Ollama\nMuse failure → Ollama · Groq out of capacity → Ollama fallback model', 'messaging', [ev(H, r'class HybridStructuredLlmAdapter', 60)])
    p.box('vision', 665, 520, 370, 130, 'FallbackVisionAdapter', 'Cloudflare first; Groq vision when Cloudflare reports its daily allocation spent\nGroq key pool with per-key cool-down', 'messaging', [ev('apps/ai-service/src/infrastructure/adapters/fallback-vision.adapter.ts', None, 40), ev('apps/ai-service/src/infrastructure/services/groq-key-pool.service.ts', None, 30)])
    p.box('asr', 665, 690, 370, 90, 'Groq transcription adapter', 'Opus audio · key pool', 'messaging', [ev('apps/ai-service/src/infrastructure/adapters/groq-transcription.adapter.ts', None, 30)])
    p.box('teiad', 665, 820, 370, 90, 'TEI embedding + reranker adapters', 'HTTP · bounded concurrency · timeouts', 'messaging', [ev('apps/ai-service/src/infrastructure/adapters/tei-embedding.adapter.ts', None, 30)])
    for rid, tgt, py in [('r1', 'hybrid', 200), ('r2', 'hybrid', 260), ('r3', 'hybrid', 320), ('r4', 'hybrid', 380)]:
        p.edge(rid, tgt, '', 'sync', exit=(1, 0.5), entry=(0, (py - 150) / 330))
    p.edge('r5', 'vision', '', 'sync', exit=(1, 0.5), entry=(0, 0.5))
    p.edge('r6', 'asr', '', 'sync', exit=(1, 0.5), entry=(0, 0.5))
    p.edge('r7', 'teiad', '', 'sync', exit=(1, 0.5), entry=(0, 0.5), points=[(600, 1060), (600, 865)])

    p.zone('z-hosts', 1140, 100, 730, 980, 'Model hosts', 'external')
    p.box('ollama', 1170, 150, 330, 120, 'Ollama · developer laptop', 'gemma4:e2b-it-qat for every text role by default\none request at a time · reverse SSH tunnel', 'ai', [ev('docs/model-host.md', None, 14), ev('.env.example', r'AI_ROUTER_MODEL')])
    p.box('muse', 1520, 150, 320, 120, 'Muse gateway (optional)', 'indexing text roles only · AI_MUSE_ROLES\n~2 parallel requests', 'ai', [ev('apps/ai-service/src/infrastructure/adapters/muse-structured-llm.adapter.ts', None, 30)], dashed=True)
    p.box('groqllm', 1170, 310, 330, 100, 'Groq chat models (optional)', 'router · planner · answer when hybrid is on', 'external', [ev(H, r'const GROQ_ROLES'), ev('.env.example', r'AI_GROQ_HYBRID_ENABLED')], dashed=True)
    p.cloud('cfai', 1170, 520, 330, 110, 'Cloudflare Workers AI', 'Llama 4 Scout vision · AI Gateway', [ev('apps/ai-service/src/infrastructure/adapters/cloudflare-vision.adapter.ts', None, 30)])
    p.cloud('groqv', 1520, 520, 320, 110, 'Groq vision', 'qwen3.8-27b · free-tier keys', [ev('apps/ai-service/src/infrastructure/adapters/groq-vision.adapter.ts', None, 30)])
    p.cloud('groqa', 1170, 680, 330, 100, 'Groq Whisper', 'whisper-large-v3-turbo', [ev('apps/ai-service/src/infrastructure/adapters/groq-transcription.adapter.ts', None, 30)])
    p.service('tei', 1170, 820, 330, 100, 'TEI runtime · homelab', 'rag-embedding bge-m3 (1024 dim)\nrag-reranker mmarco cross-encoder', 'ai', [ev('docker-compose.yml', r'rag-embedding:'), ev('.env.example', r'TEI_RERANKER_MODEL')])
    p.edge('hybrid', 'ollama', 'default', 'sync', exit=(1, 0.2), entry=(0, 0.5), points=[(1100, 216), (1100, 210)])
    p.edge('hybrid', 'muse', 'Muse roles', 'external', exit=(1, 0.05), entry=(0.5, 0), points=[(1050, 166), (1050, 125), (1680, 125)])
    p.edge('hybrid', 'groqllm', 'Groq roles', 'external', exit=(1, 0.85), entry=(0, 0.5), points=[(1090, 430), (1090, 360)])
    p.edge('vision', 'cfai', 'primary', 'sync', exit=(1, 0.3), entry=(0, 0.5), points=[(1100, 559), (1100, 575)])
    p.edge('cfai', 'groqv', 'allocation spent', 'external', exit=(1, 0.5), entry=(0, 0.5))
    p.edge('asr', 'groqa', '', 'sync', exit=(1, 0.5), entry=(0, 0.5))
    p.edge('teiad', 'tei', '', 'sync', exit=(1, 0.5), entry=(0, 0.5))
    p.text('Default: every text role runs on Ollama. AI_GROQ_HYBRID_ENABLED moves router, planner and answer to Groq; AI_MUSE_ENABLED with AI_MUSE_ROLES moves indexing text roles to Muse. A Muse failure falls back to Ollama so indexing never blocks.', 1170, 950, 670, 80, size=11, color='#475569')
    p.legend(60, 1110, [('sync', 'Default path'), ('external', 'Optional path or fallback')], title='')
    return p.element()


def page_02e():
    p = Page('02e-mobile-client-architecture', '02e · Velora-Mobile client architecture', 1900, 1000,
             'The phone app in layers, and the three ways it reaches the backend: REST, the chat socket, and direct storage access for video',
             scope='Velora-Mobile repository (/home/hieucutedangyeu/Velora-Mobile); backend paths from the nginx and gateway configuration')
    p.zone('z-ui', 40, 100, 640, 840, 'Velora-Mobile · Expo SDK 54 · React Native 0.81', 'client')
    p.box('screens', 65, 150, 590, 110, 'Screens · expo-router', 'tabs: home · reels · friends · search · profile\nconversation (AI agent) · reels · series · users · settings · sign-in', 'client', [mev('package.json', r'expo-router'), mev('app/_layout.tsx', None, 30)])
    p.box('providers', 65, 285, 590, 120, 'Providers and stores', 'AuthProvider · QueryProvider (TanStack Query) · SocketProvider\nNetworkProvider · ChatMediaUploadProvider · zustand stores', 'client', [mev('src/providers/SocketProvider.tsx', None, 30), mev('src/providers/AuthProvider.tsx', None, 30), mev('src/stores/authStore.ts', None, 20)])
    p.box('api', 65, 430, 590, 110, 'REST client · axios', 'src/api/*.api.ts · one shared refresh request when several calls get a 401\na refreshRequestId makes a lost refresh response recoverable', 'client', [mev('src/api/client.ts', None, 60)])
    p.box('sock', 65, 565, 590, 90, 'socket.io-client', 'chat socket · the AI agent streams its answer as bot_token events\nbot_reply_failed reports a failed answer', 'client', [mev('src/providers/SocketProvider.tsx', None, 40)])
    p.box('media', 65, 680, 590, 110, 'Playback and capture', 'expo-video HLS + expo-video-cache (offline copy) · expo-camera\nexpo-image-picker · video trim and crop · thumbnails · subtitles', 'client', [mev('src/lib/offlineReelVideoCache.ts', None, 30), mev('src/lib/reelSubtitles.ts', None, 30)])
    p.box('store', 65, 815, 590, 100, 'Local persistence', 'WatermelonDB (messages · reels) · SecureStore (tokens)\nreel event outbox · durable publish checkpoints · offline reel cache', 'data', [mev('src/database/schema.ts', None, 30), mev('src/lib/reelEventsOutbox.ts', None, 30), mev('src/lib/reelPublishPersistence.ts', None, 30)])
    for a, b in [('screens', 'providers'), ('providers', 'api'), ('api', 'sock'), ('sock', 'media'), ('media', 'store')]:
        p.edge(a, b, '', 'link', exit=(0.1, 1), entry=(0.1, 0))

    p.cloud('cf', 800, 150, 250, 100, 'Cloudflare', 'tunnel · CDN', [ev('docs/rate-limiting-and-guardrails.md', r'Production topology')])
    p.service('nginx', 1130, 170, 200, 70, 'Nginx', 'REST · /socket.io', 'edge', [ev('infra/nginx/nginx.conf', r'upstream api_gateway')])
    p.service('gw', 1400, 150, 220, 90, 'API Gateway', 'REST · login check · rate limits', 'api', [ev('apps/api-gateway/src/api-gateway.module.ts', r'ClientsModule\.registerAsync')])
    p.service('conv', 1400, 290, 220, 90, 'Conversation Service', 'AI agent chat · shared Reels', 'realtime', [ev('apps/conversation-service/src/infrastructure/gateways/chat.gateway.ts', None, 30)])
    p.cloud('r2', 1120, 480, 260, 110, 'Cloudflare R2 + CDN', 'presigned original PUT · HLS GET', [ev('apps/media-service/src/infrastructure/services/s3.service.ts', r'S3Client')])
    p.cloud('goog', 1120, 780, 260, 100, 'Google', 'sign-in identity token', [ev('apps/auth-service/src/application/use-cases/verify-google-token.use-case.ts', None, 30)])
    p.edge('api', 'cf', 'HTTPS REST', 'sync', exit=(1, 0.3), entry=(0, 0.3), points=[(740, 463), (740, 180)])
    p.edge('sock', 'cf', 'WSS', 'sync', exit=(1, 0.5), entry=(0, 0.5), points=[(760, 610), (760, 200)])
    p.edge('cf', 'nginx', '', 'sync', exit=(1, 0.5), entry=(0, 0.5))
    p.edge('nginx', 'gw', 'REST', 'sync', exit=(1, 0.3), entry=(0, 0.5), points=[(1370, 191), (1370, 195)])
    p.edge('nginx', 'conv', 'Socket.IO', 'sync', exit=(0.5, 1), entry=(0, 0.5), points=[(1230, 335)])
    p.edge('media', 'r2', 'HLS GET · original PUT', 'external', exit=(1, 0.5), entry=(0, 0.5), points=[(800, 735), (800, 535)])
    p.edge('providers', 'goog', 'sign-in', 'external', exit=(1, 0.5), entry=(0, 0.5), points=[(700, 345), (700, 830)])
    p.legend(1400, 480, [('sync', 'REST / Socket.IO through the edge'), ('external', 'Direct to a provider'), ('link', 'Layer depends on the one below')], title='Legend')
    return p.element()


PAGES = [page_01, page_02, page_02a, page_02b, page_02c, page_02d, page_02e]

if __name__ == '__main__':
    import argparse
    import xml.etree.ElementTree as ET
    parser = argparse.ArgumentParser()
    parser.add_argument('--preview', type=Path, help='write standalone .drawio files here instead of editing the master file')
    parser.add_argument('--only', help='comma-separated page-function names')
    args = parser.parse_args()
    chosen = [fn for fn in PAGES if not args.only or fn.__name__ in args.only.split(',')]
    elements = [fn() for fn in chosen]
    if args.preview:
        args.preview.mkdir(parents=True, exist_ok=True)
        for element in elements:
            (args.preview / f"{element.attrib['id']}.drawio").write_text('<mxfile>' + ET.tostring(element, encoding='unicode') + '</mxfile>')
        print(f'Wrote {len(elements)} preview pages')
    else:
        install(elements)
        print(f'Installed {len(elements)} architecture pages')
