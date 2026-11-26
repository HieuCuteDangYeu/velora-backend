#!/usr/bin/env python3
"""Disposable two-node Qdrant cluster rehearsal (stdlib only, needs docker).

Rehearses what a second Qdrant replica would need before anything touches production:
  1. a single node built like production (cluster disabled), collection created with the
     exact body of QdrantReelVectorStoreAdapter.initialize(), 11k synthetic points
  2. the same storage restarted with cluster mode and p2p TLS (as production would restart)
  3. a second peer, then shard replication of the EXISTING collection (never recreation)
  4. replication_factor 2, node-kill tests, topology changes with two peers, write latency

Everything is disposable: containers rh-a / rh-b, network rh-net, volumes rh-a-* / rh-b-*,
a throwaway CA. Usage: rehearse.py <secrets-dir> [phase ...]   (default: all phases)
Results are printed as one JSON line per measurement prefixed with RESULT.
"""
import json
import math
import random
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

SECRETS = sys.argv[1]
PHASES = sys.argv[2:] or ["single", "cluster", "replicate", "kill-b", "kill-a", "latency"]
IMAGE = "qdrant/qdrant:v1.20.0@sha256:9bfc89f9914fc14876a88c05270685921a55b8877b254a98bcc1cc2f0a424cd2"
HERE = __file__.rsplit("/", 1)[0]
CONFIG = HERE + "/../config.yaml"
ENTRYPOINT = HERE + "/../entrypoint.sh"
COLLECTION = "velora_reel_bge_m3_1024_v1"
ALIAS = "velora_reel_semantic"
PORT = {"a": 6433, "b": 6434}
NET = "rh-net"
POINTS = 11316
KEY = open(SECRETS + "/api-key").read().strip()
CTX = ssl.create_default_context(cafile=SECRETS + "/ca.crt")
FIELDS = ["kind", "reelId", "indexAttemptId", "projectionGeneration", "manifestHash", "userId",
          "parentId", "indexVersion", "embeddingProvider", "embeddingModel", "embeddingVersion",
          "tags", "sourceLengthClass"]


def result(_label, /, **values):
    print("RESULT " + json.dumps({"result": _label, **values}, default=str), flush=True)


def sh(*args, check=True):
    out = subprocess.run(args, capture_output=True, text=True)
    if check and out.returncode:
        raise RuntimeError("%s -> %s" % (" ".join(args)[:200], out.stderr[:300]))
    return out.stdout.strip()


def q(node, method, path, body=None, timeout=5.0):
    """Returns (http status or 0, json or error text, milliseconds)."""
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        "https://localhost:%d%s" % (PORT[node], path), data=data, method=method,
        headers={"api-key": KEY, "content-type": "application/json"})
    start = time.time()
    try:
        with urllib.request.urlopen(request, context=CTX, timeout=timeout) as response:
            raw = response.read() or b"null"
            try:
                payload = json.loads(raw)
            except ValueError:  # /readyz answers plain text
                payload = raw.decode()[:200]
            return response.status, payload, round((time.time() - start) * 1000)
    except urllib.error.HTTPError as error:
        text = error.read().decode()[:300]
        return error.code, text, round((time.time() - start) * 1000)
    except Exception as error:  # connection refused, timeout, TLS failure
        return 0, type(error).__name__ + ": " + str(error)[:120], round((time.time() - start) * 1000)


def start(node, cluster, peer_args=()):
    name = "rh-" + node
    sh("docker", "rm", "-f", name, check=False)
    env = ["-e", "QDRANT__CLUSTER__ENABLED=true", "-e", "QDRANT__CLUSTER__P2P__ENABLE_TLS=true",
           "-e", "QDRANT__CLUSTER__CONSENSUS__TICK_PERIOD_MS=100"] if cluster else []
    sh("docker", "run", "-d", "--name", name, "--network", NET, "--network-alias", "qdrant-" + node,
       "-p", "127.0.0.1:%d:6333" % PORT[node], "--cpus", "1.0", "--memory", "768m",
       "--entrypoint", "bash", *env,
       "-v", "rh-%s-storage:/qdrant/storage" % node, "-v", "rh-%s-snapshots:/qdrant/snapshots" % node,
       "-v", CONFIG + ":/qdrant/config/velora.yaml:ro", "-v", ENTRYPOINT + ":/qdrant/velora-entrypoint.sh:ro",
       "-v", SECRETS + "/api-key:/run/secrets/qdrant_api_key:ro",
       "-v", SECRETS + "/server.crt:/run/secrets/qdrant_tls_cert:ro",
       "-v", SECRETS + "/server.key:/run/secrets/qdrant_tls_key:ro",
       "-v", SECRETS + "/ca.crt:/run/secrets/qdrant_tls_ca:ro",
       IMAGE, "/qdrant/velora-entrypoint.sh", *peer_args)
    wait_ready(node)


def wait_ready(node, seconds=90):
    end = time.time() + seconds
    while time.time() < end:
        if q(node, "GET", "/readyz", timeout=2)[0] == 200:
            return
        time.sleep(1)
    raise RuntimeError("node %s not ready: %s" % (node, sh("docker", "logs", "--tail", "15", "rh-" + node, check=False)))


def vector(rng):
    values = [rng.gauss(0, 1) for _ in range(1024)]
    norm = math.sqrt(sum(v * v for v in values))
    return [v / norm for v in values]


def make_points(count, seed=7, offset=0):
    rng = random.Random(seed)
    reels = ["reel-%03d" % i for i in range(298)]
    points = []
    for i in range(offset, offset + count):
        reel = reels[i % len(reels)]
        points.append({
            "id": str(uuid.UUID(int=(i + 1) * 7919 + 12345)),
            "vector": vector(rng),
            "payload": {"kind": "CHUNK", "stableId": "c%d" % i, "reelId": reel, "indexAttemptId": "a-" + reel,
                        "projectionGeneration": "1", "manifestHash": "m-" + reel, "userId": "u1", "parentId": None,
                        "ordinal": i, "tags": ["t%d" % (i % 9)], "sourceLengthClass": "SHORT", "indexVersion": "v1",
                        "embeddingProvider": "p", "embeddingModel": "m", "embeddingVersion": "1",
                        "embeddingDimensions": 1024, "embeddingInputHash": "h%d" % i, "retrievalHash": "r%d" % i,
                        "evidenceHash": None, "vectorHash": "v%d" % i}})
    return points


def upsert(node, points, timeout=30.0):
    return q(node, "PUT", "/collections/%s/points?wait=true&ordering=strong" % COLLECTION,
             {"points": points}, timeout=timeout)


def search(node, point_ids, vec, timeout=5.0):
    """Same request shape as QdrantReelVectorStoreAdapter.search (exact, has_id filter)."""
    return q(node, "POST", "/collections/%s/points/query" % COLLECTION, {
        "query": vec, "params": {"exact": True}, "limit": 5, "with_payload": True, "with_vector": False,
        "filter": {"must": [{"has_id": point_ids}, {"key": "kind", "match": {"value": "CHUNK"}}]}}, timeout=timeout)


def count(node):
    status, body, _ = q(node, "POST", "/collections/%s/points/count" % COLLECTION, {"exact": True})
    return body["result"]["count"] if status == 200 else None


def info(node):
    status, body, _ = q(node, "GET", "/collections/" + COLLECTION)
    return body["result"] if status == 200 else None


def probe_set():
    pts = make_points(40, seed=7)
    return [p["id"] for p in pts], [p["vector"] for p in pts[:12]]


def probes(node, label):
    ids, vecs = probe_set()
    times, ok, errors = [], 0, set()
    for vec in vecs:
        status, body, ms = search(node, ids, vec)
        times.append(ms)
        if status == 200 and body["result"]["points"] and body["result"]["points"][0]["id"] == ids[vecs.index(vec)]:
            ok += 1
        elif status != 200:
            errors.add(str(status) + ":" + str(body)[:80])
    times.sort()
    result("search-probes", node=node, label=label, ok=ok, of=len(vecs), p50=times[len(times) // 2],
           max=times[-1], errors=sorted(errors))
    return ok


def cluster(node):
    status, body, _ = q(node, "GET", "/cluster")
    return body["result"] if status == 200 else body


def shard_state(node):
    status, body, _ = q(node, "GET", "/collections/%s/cluster" % COLLECTION)
    return body["result"] if status == 200 else body


def setup():
    sh("docker", "network", "create", NET, check=False)


def phase_single():
    for node in "ab":
        sh("docker", "rm", "-f", "rh-" + node, check=False)
        for suffix in ("storage", "snapshots"):
            sh("docker", "volume", "rm", "-f", "rh-%s-%s" % (node, suffix), check=False)
    start("a", cluster=False)
    body = {"vectors": {"size": 1024, "distance": "Cosine", "datatype": "float32", "memory": "cached"},
            "payload": {"memory": "cached"}, "shard_number": 1, "replication_factor": 1,
            "hnsw_config": {"m": 16, "ef_construct": 100, "memory": "cached", "max_indexing_threads": 1},
            "optimizers_config": {"default_segment_number": 1, "max_optimization_threads": 1}}
    print("create", q("a", "PUT", "/collections/" + COLLECTION, body)[:2])
    for field in FIELDS:
        q("a", "PUT", "/collections/%s/index?wait=true" % COLLECTION, {"field_name": field, "field_schema": "keyword"})
    q("a", "POST", "/collections/aliases", {"actions": [{"create_alias": {"collection_name": COLLECTION, "alias_name": ALIAS}}]})
    points = make_points(POINTS)
    start_t = time.time()
    for i in range(0, len(points), 128):
        status, body, _ = upsert("a", points[i:i + 128])
        assert status == 200, (status, body)
    result("single-node-load", points=count("a"), seconds=round(time.time() - start_t, 1))
    green_t = time.time()
    while time.time() - green_t < 180 and info("a")["status"] != "green":
        time.sleep(2)
    result("time-to-green-after-load", seconds=round(time.time() - green_t, 1))
    i = info("a")
    result("single-node-collection", created_at=i["created_at"], status=i["status"], indexed=i.get("indexed_vectors_count"),
           payload_indexes=len(i["payload_schema"]), shards=i["config"]["params"].get("shard_number"),
           replication_factor=i["config"]["params"].get("replication_factor"),
           write_consistency_factor=i["config"]["params"].get("write_consistency_factor"))
    probes("a", "single-node baseline")
    result("single-node-memory", mem=sh("docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", "rh-a"))


def phase_cluster():
    before = info("a")
    sh("docker", "stop", "-t", "20", "rh-a")
    start_t = time.time()
    start("a", cluster=True, peer_args=["--uri", "https://qdrant-a:6335"])
    time.sleep(5)
    after = info("a")
    result("enable-cluster-restart", downtime_seconds=round(time.time() - start_t, 1),
           created_at_unchanged=before["created_at"] == after["created_at"], points=count("a"),
           status=after["status"] if after else None)
    result("cluster-info-a", info=cluster("a"))
    probes("a", "after cluster enable")


def peer_id(node):
    return cluster(node)["peer_id"]


def phase_replicate():
    for suffix in ("storage", "snapshots"):
        sh("docker", "volume", "rm", "-f", "rh-b-" + suffix, check=False)
    start("b", cluster=True, peer_args=["--bootstrap", "https://qdrant-a:6335", "--uri", "https://qdrant-b:6335"])
    time.sleep(8)
    result("two-peers", peers=cluster("a").get("peers", {}).keys() if isinstance(cluster("a"), dict) else None,
           raft=cluster("a").get("raft_info") if isinstance(cluster("a"), dict) else None)
    a, b = peer_id("a"), peer_id("b")
    status, body, ms = q("a", "POST", "/collections/%s/cluster?wait=true" % COLLECTION,
                         {"replicate_shard": {"shard_id": 0, "from_peer_id": a, "to_peer_id": b, "method": "snapshot"}}, timeout=120)
    result("replicate-request", status=status, body=body, ms=ms)
    start_t = time.time()
    worst = []
    while time.time() - start_t < 240:
        state = shard_state("a")
        if isinstance(state, dict):
            replicas = state.get("local_shards", []) + state.get("remote_shards", [])
            transfers = state.get("shard_transfers", [])
            ok = probes_quiet("a")
            worst.append(ok)
            if not transfers and any(r.get("state") == "Active" and r.get("peer_id") == b for r in state.get("remote_shards", [])):
                break
        time.sleep(1)
    result("replicate-done", seconds=round(time.time() - start_t, 1), state=shard_state("a"),
           search_during_transfer_failures=len([x for x in worst if not x]), samples=len(worst))
    # collection identity must be identical on both peers
    ia, ib = info("a"), info("b")
    result("replica-identity", a_created=ia["created_at"], b_created=ib["created_at"], a_count=count("a"), b_count=count("b"),
           status_a=ia["status"], status_b=ib["status"])
    status, body, _ = q("a", "PATCH", "/collections/" + COLLECTION, {"params": {"replication_factor": 2}})
    result("set-replication-factor-2", status=status, body=body, now=info("a")["config"]["params"])
    probes("a", "after replication, via A")
    probes("b", "after replication, via B")
    result("memory", a=sh("docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", "rh-a"),
           b=sh("docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", "rh-b"))


def probes_quiet(node):
    ids, vecs = probe_set()
    status, body, _ = search(node, ids, vecs[0])
    return status == 200 and body["result"]["points"][0]["id"] == ids[0]


def write_test(node, label, offset):
    pts = make_points(128, seed=99, offset=offset)
    status, body, ms = upsert(node, pts, timeout=15)
    result("write", node=node, label=label, status=status, ms=ms, body=str(body)[:160])
    return status == 200


def phase_kill(victim):
    survivor = "a" if victim == "b" else "b"
    result("kill-start", victim=victim, count_a=count("a"), count_b=count("b"))
    sh("docker", "kill", "rh-" + victim)
    time.sleep(3)
    probes(survivor, "%s killed, survivor %s, +3s" % (victim, survivor))
    write_test(survivor, "write with peer down (wcf default)", 50000 + (0 if victim == "b" else 1000))
    time.sleep(12)
    probes(survivor, "%s killed, +15s" % victim)
    write_test(survivor, "write with peer down, +15s", 51000 + (0 if victim == "b" else 1000))
    result("survivor-shard-state", state=shard_state(survivor))
    result("survivor-collection-status", info=(info(survivor) or {}).get("status"))
    status, body, ms = q(survivor, "PUT", "/collections/rh_probe_%s" % victim, {"vectors": {"size": 4, "distance": "Cosine"}}, timeout=25)
    result("topology-change-create-collection", status=status, body=body, ms=ms)
    status, body, ms = q(survivor, "POST", "/collections/aliases", {"actions": [{"create_alias": {"collection_name": COLLECTION, "alias_name": "rh_alias_probe"}}]}, timeout=25)
    result("topology-change-create-alias", status=status, body=body, ms=ms)
    status, body, ms = q(survivor, "GET", "/cluster")
    result("cluster-info-survivor", status=status, body=body, ms=ms)
    # set write consistency 2 while degraded (needs consensus) and test writes
    start_t = time.time()
    start(victim, cluster=True, peer_args=(["--bootstrap", "https://qdrant-a:6335", "--uri", "https://qdrant-b:6335"] if victim == "b"
                                           else ["--bootstrap", "https://qdrant-b:6335", "--uri", "https://qdrant-a:6335"]))
    # an old peer restarts with its stored raft state; no --bootstrap needed but harmless
    time.sleep(10)
    result("restart-victim", victim=victim, seconds_to_ready=round(time.time() - start_t, 1))
    deadline = time.time() + 120
    while time.time() < deadline:
        state = shard_state(survivor)
        flat = json.dumps(state)
        if isinstance(state, dict) and '"Dead"' not in flat and '"Partial"' not in flat and not state.get("shard_transfers"):
            break
        time.sleep(2)
    result("recovered", seconds=round(time.time() - start_t, 1), state=shard_state(survivor), count_a=count("a"), count_b=count("b"))
    probes("a", "after recovery, via A")
    probes("b", "after recovery, via B")


def netem(args):
    sh("docker", "run", "--rm", "--cap-add", "NET_ADMIN", "--network", "container:rh-b", "nicolaka/netshoot", "sh", "-c", args, check=False)


def phase_latency():
    """Synchronous 128-point writes (the adapter's batch size) while peer B sits behind a delay."""
    if "tc" not in sh("docker", "run", "--rm", "--network", "container:rh-b", "nicolaka/netshoot", "sh", "-c", "command -v tc", check=False):
        result("latency", skipped="no tc available")
        return
    for delay, jitter in ((0, 0), (6, 0), (6, 3), (18, 0), (30, 0), (30, 10)):
        netem("tc qdisc del dev eth0 root 2>/dev/null; " + ("tc qdisc add dev eth0 root netem delay %dms %dms" % (delay, jitter) if delay else "true"))
        times = []
        for i in range(10):
            pts = make_points(128, seed=5, offset=100000 + i * 128 + delay * 20000 + jitter * 3000)
            status, body, ms = upsert("a", pts, timeout=30)
            times.append((status, ms))
        ok = sorted(ms for status, ms in times if status == 200)
        result("write-latency", delay_ms=delay, jitter_ms=jitter, ok=len(ok), of=len(times), p50=ok[len(ok) // 2] if ok else None,
               max=max(ms for _, ms in times), over_5s=len([1 for _, ms in times if ms > 5000]), statuses=sorted({s for s, _ in times}))
        probes_quiet("a")
    netem("tc qdisc del dev eth0 root 2>/dev/null")


def phase_topology():
    """Permanent loss of the peer that leads the shard: what an operator can still do."""
    b = peer_id("b")
    sh("docker", "kill", "rh-b")
    time.sleep(3)
    write_test("a", "B dead, before any topology change", 70000)
    status, body, ms = q("a", "DELETE", "/cluster/peer/%s" % b, timeout=25)
    result("remove-dead-peer-without-force", status=status, body=body, ms=ms)
    status, body, ms = q("a", "DELETE", "/cluster/peer/%s?force=true" % b, timeout=25)
    result("remove-dead-peer-with-force", status=status, body=body, ms=ms)
    time.sleep(5)
    write_test("a", "after forced removal of B", 71000)
    probes("a", "after forced removal of B")
    status, body, ms = q("a", "POST", "/collections/aliases", {"actions": [{"create_alias": {"collection_name": COLLECTION, "alias_name": "rh_alias_after_force"}}]}, timeout=25)
    result("consensus-op-after-force", status=status, body=body, ms=ms)
    result("peers-after-force", cluster=cluster("a"), shards=shard_state("a"))


def main():
    setup()
    table = {"single": phase_single, "cluster": phase_cluster, "replicate": phase_replicate,
             "kill-b": lambda: phase_kill("b"), "kill-a": lambda: phase_kill("a"), "latency": phase_latency, "topology": phase_topology}
    for phase in PHASES:
        result("phase", phase=phase)
        table[phase]()


main()
