#!/usr/bin/env python3
"""Disposable THREE-node Qdrant rehearsal, layout D: two nodes on the homelab host, one on the laptop.

Nodes: h = H1 on the homelab (the node the indexers talk to), m = H2 on the same host (small container,
own storage, own peer port), l = the laptop on homelab 2. Only the homelab-laptop link is emulated
(netem on each node's egress, one way: 6 ms with 3 ms jitter, 25 % correlation, plus optional spikes
to 40 ms); h-m is local and untouched.

Usage: rehearse4.py <secrets-dir> golden
       rehearse4.py <secrets-dir> layout <D|D2> [step,step,...]
              steps: form latency reads kills ids failover
       rehearse4.py <secrets-dir> raft
Layouts: D replica on h and l, m is a data-less voter (replication_factor 2); D2 replicas on h, m and l
(replication_factor 3). Everything is disposable (containers r4-*, network r4-net, volumes r4-*).
One JSON line per measurement, prefixed RESULT.
"""
import json
import math
import random
import re
import ssl
import statistics
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

SECRETS = sys.argv[1]
CMD = sys.argv[2]
HERE = __file__.rsplit("/", 1)[0]
IMAGE = "qdrant/qdrant:v1.20.0@sha256:9bfc89f9914fc14876a88c05270685921a55b8877b254a98bcc1cc2f0a424cd2"
UTIL = "nicolaka/netshoot"
COLLECTION = "velora_reel_bge_m3_1024_v1"
ALIAS = "velora_reel_semantic"
POINTS = 11316
NET = "r4-net"
NODES = {"h": ("172.31.0.11", 6443, 1.0, "768m"), "m": ("172.31.0.12", 6444, 0.5, "384m"), "l": ("172.31.0.13", 6445, 1.0, "768m")}
NODE_KEYS = "hml"
DELAY = {("h", "l"): (6, 3), ("m", "l"): (6, 3)}  # h-m is the same host: not emulated
CLIENT_RTT = {"h": 0.0, "m": 0.0005, "l": 0.012}  # simulated client on the homelab, seconds
KEY = open(SECRETS + "/api-key").read().strip()
CTX = ssl.create_default_context(cafile=SECRETS + "/ca.crt")
FIELDS = ["kind", "reelId", "indexAttemptId", "projectionGeneration", "manifestHash", "userId", "parentId",
          "indexVersion", "embeddingProvider", "embeddingModel", "embeddingVersion", "tags", "sourceLengthClass"]
PID = {}
_offset = [int(time.time()) % 100000 * 1000 + 5000000]


def result(_label, /, **values):
    print("RESULT " + json.dumps({"result": _label, **values}, default=str), flush=True)


def sh(*args, check=True, timeout=120):
    out = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and out.returncode:
        raise RuntimeError("%s -> %s" % (" ".join(args)[:160], out.stderr[:300]))
    return out.stdout.strip()


def q(node, method, path, body=None, timeout=5.0, simulate_rtt=False):
    if simulate_rtt:
        time.sleep(CLIENT_RTT[node])
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request("https://localhost:%d%s" % (NODES[node][1], path), data=data, method=method,
                                     headers={"api-key": KEY, "content-type": "application/json"})
    start = time.time()
    try:
        with urllib.request.urlopen(request, context=CTX, timeout=timeout) as response:
            raw = response.read() or b"null"
            try:
                payload = json.loads(raw)
            except ValueError:
                payload = raw.decode()[:200]
            return response.status, payload, round((time.time() - start) * 1000 + CLIENT_RTT[node] * 1000 * simulate_rtt)
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()[:260], round((time.time() - start) * 1000)
    except Exception as error:
        return 0, type(error).__name__ + ": " + str(error)[:100], round((time.time() - start) * 1000)


# ---------------------------------------------------------------- containers and network shaping
def start(k, cluster, bootstrap=None):
    name = "r4-" + k
    sh("docker", "rm", "-f", name, check=False)
    ip, port, cpus, mem = NODES[k]
    env = ["-e", "QDRANT__CLUSTER__ENABLED=true", "-e", "QDRANT__CLUSTER__P2P__ENABLE_TLS=true"] if cluster else []
    args = ["--uri", "https://r4-%s:6335" % k] if cluster else []
    if bootstrap:
        args += ["--bootstrap", "https://r4-%s:6335" % bootstrap]
    sh("docker", "run", "-d", "--name", name, "--network", NET, "--ip", ip, "--network-alias", "r4-" + k,
       "-p", "127.0.0.1:%d:6333" % port, "--cpus", str(cpus), "--memory", mem, "--entrypoint", "bash", *env,
       "-v", "r4-%s-storage:/qdrant/storage" % k, "-v", "r4-%s-snapshots:/qdrant/snapshots" % k,
       "-v", HERE + "/../config.yaml:/qdrant/config/velora.yaml:ro",
       "-v", HERE + "/../entrypoint.sh:/qdrant/velora-entrypoint.sh:ro",
       "-v", SECRETS + "/api-key:/run/secrets/qdrant_api_key:ro", "-v", SECRETS + "/server.crt:/run/secrets/qdrant_tls_cert:ro",
       "-v", SECRETS + "/server.key:/run/secrets/qdrant_tls_key:ro", "-v", SECRETS + "/ca.crt:/run/secrets/qdrant_tls_ca:ro",
       IMAGE, "/qdrant/velora-entrypoint.sh", *args)
    wait_ready(k)


def wait_ready(k, seconds=120):
    end = time.time() + seconds
    while time.time() < end:
        if q(k, "GET", "/readyz", timeout=3)[0] == 200:
            return
        time.sleep(1)
    raise RuntimeError("node %s not ready" % k)


def tc(k, script):
    sh("docker", "run", "--rm", "--cap-add", "NET_ADMIN", "--network", "container:r4-" + k, UTIL, "sh", "-c", script, check=False)


def shaped_peers(k):
    return [p for p in NODES if p != k and ((k, p) in DELAY or (p, k) in DELAY)]


def delay_for(a, b):
    return DELAY.get((a, b)) or DELAY[(b, a)]


def shape(k):
    cmds = ["tc qdisc del dev eth0 root 2>/dev/null"]
    peers = shaped_peers(k)
    if peers:
        cmds.append("tc qdisc add dev eth0 root handle 1: prio bands 4 priomap 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3")
    for band, peer in enumerate(peers, start=1):
        d, j = delay_for(k, peer)
        cmds.append("tc qdisc add dev eth0 parent 1:%d handle %d0: netem delay %dms %dms 25%%" % (band, band, d, j))
        cmds.append("tc filter add dev eth0 protocol ip parent 1:0 prio 1 u32 match ip dst %s flowid 1:%d" % (NODES[peer][0], band))
    tc(k, "; ".join(cmds))


def set_delay(k, peer, d, j):
    band = shaped_peers(k).index(peer) + 1
    tc(k, "tc qdisc change dev eth0 parent 1:%d handle %d0: netem delay %dms %dms 25%%" % (band, band, d, j))


def teardown():
    for k in NODES:
        sh("docker", "rm", "-f", "r4-" + k, check=False)
    for k in NODES:
        for suffix in ("storage", "snapshots"):
            sh("docker", "volume", "rm", "-f", "r4-%s-%s" % (k, suffix), check=False)


# ---------------------------------------------------------------- data
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
        points.append({"id": str(uuid.UUID(int=(i + 1) * 7919 + 12345)), "vector": vector(rng),
                       "payload": {"kind": "CHUNK", "stableId": "c%d" % i, "reelId": reel, "indexAttemptId": "a-" + reel,
                                   "projectionGeneration": "1", "manifestHash": "m-" + reel, "userId": "u1", "parentId": None,
                                   "ordinal": i, "tags": ["t%d" % (i % 9)], "sourceLengthClass": "SHORT", "indexVersion": "v1",
                                   "embeddingProvider": "p", "embeddingModel": "m", "embeddingVersion": "1",
                                   "embeddingDimensions": 1024, "embeddingInputHash": "h%d" % i, "retrievalHash": "r%d" % i,
                                   "evidenceHash": None, "vectorHash": "v%d" % i}})
    return points


def fresh_points(count=128):
    _offset[0] += count
    return make_points(count, seed=_offset[0], offset=_offset[0])


def upsert(k, points, ordering="strong", timeout=12.0):
    return q(k, "PUT", "/collections/%s/points?wait=true&ordering=%s" % (COLLECTION, ordering), {"points": points}, timeout=timeout)


PROBE_IDS = [p["id"] for p in make_points(40, seed=7)]
PROBE_VECS = [p["vector"] for p in make_points(12, seed=7)]


def search(k, vec, ids=None, timeout=5.0, rtt=False):
    return q(k, "POST", "/collections/%s/points/query" % COLLECTION, {
        "query": vec, "params": {"exact": True}, "limit": 5, "with_payload": True, "with_vector": False,
        "filter": {"must": [{"has_id": ids or PROBE_IDS}, {"key": "kind", "match": {"value": "CHUNK"}}]}}, timeout=timeout, simulate_rtt=rtt)


def probe(k, n=3):
    ok, times = 0, []
    for vec in PROBE_VECS[:n]:
        status, body, ms = search(k, vec)
        times.append(ms)
        ok += status == 200 and bool(body["result"]["points"]) and body["result"]["points"][0]["id"] == PROBE_IDS[PROBE_VECS.index(vec)]
    return {"ok": "%d/%d" % (ok, n), "p50": sorted(times)[len(times) // 2]}


def info(k):
    status, body, _ = q(k, "GET", "/collections/" + COLLECTION)
    return body["result"] if status == 200 else None


def count(k):
    status, body, _ = q(k, "POST", "/collections/%s/points/count" % COLLECTION, {"exact": True}, timeout=8)
    return body["result"]["count"] if status == 200 else None


def cluster(k):
    status, body, _ = q(k, "GET", "/cluster", timeout=4)
    return body["result"] if status == 200 else None


def peer_ids():
    for k in NODES:
        c = cluster(k)
        if c and "peer_id" in c:
            PID[k] = c["peer_id"]
    return PID


def key_of(pid):
    return next((k for k, v in PID.items() if v == pid), str(pid))


def replica_states(k):
    status, body, _ = q(k, "GET", "/collections/%s/cluster" % COLLECTION, timeout=4)
    if status != 200:
        return None
    r = body["result"]
    out = {}
    for s in r.get("local_shards", []):
        out[key_of(r["peer_id"])] = s["state"]
    for s in r.get("remote_shards", []):
        out[key_of(s["peer_id"])] = s["state"]
    return {"states": out, "transfers": len(r.get("shard_transfers", []))}


def raft(k):
    c = cluster(k)
    if not c:
        return None
    r = c["raft_info"]
    return {"term": r["term"], "leader": key_of(r["leader"]) if r["leader"] else None, "role": r["role"], "peers": len(c["peers"])}


def alive():
    return [k for k in NODES if sh("docker", "inspect", "-f", "{{.State.Running}}", "r4-" + k, check=False) == "true"]


def wait_converged(seconds=240, want=None):
    """All alive replicas Active, no transfers, equal counts, a Raft leader known."""
    t0 = time.time()
    while time.time() - t0 < seconds:
        up = want or alive()
        states = [replica_states(k) for k in up]
        counts = [count(k) for k in up]
        leaders = [(raft(k) or {}).get("leader") for k in up]
        if all(states) and all(s["transfers"] == 0 and all(v == "Active" for v in s["states"].values()) for s in states) \
                and len(set(counts)) == 1 and None not in counts and all(leaders):
            return round(time.time() - t0, 1)
        time.sleep(2)
    return None


def wait_green(k, seconds=180):
    t0 = time.time()
    while time.time() - t0 < seconds:
        i = info(k)
        if i and i["status"] == "green":
            return round(time.time() - t0, 1)
        time.sleep(2)
    return None


# ---------------------------------------------------------------- phases
def golden_peer_id():
    raw = sh("docker", "run", "--rm", "-v", "r4-h-storage:/s", UTIL, "cat", "/s/raft_state.json")
    return int(json.loads(raw)["this_peer_id"])


def phase_golden():
    for attempt in range(1, 10):
        teardown()
        sh("docker", "network", "create", "--subnet", "172.31.0.0/24", NET, check=False)
        start("h", cluster=False)
        body = {"vectors": {"size": 1024, "distance": "Cosine", "datatype": "float32", "memory": "cached"}, "payload": {"memory": "cached"},
                "shard_number": 1, "replication_factor": 1,
                "hnsw_config": {"m": 16, "ef_construct": 100, "memory": "cached", "max_indexing_threads": 1},
                "optimizers_config": {"default_segment_number": 1, "max_optimization_threads": 1}}
        q("h", "PUT", "/collections/" + COLLECTION, body)
        for field in FIELDS:
            q("h", "PUT", "/collections/%s/index?wait=true" % COLLECTION, {"field_name": field, "field_schema": "keyword"})
        q("h", "POST", "/collections/aliases", {"actions": [{"create_alias": {"collection_name": COLLECTION, "alias_name": ALIAS}}]})
        pts = make_points(POINTS)
        for i in range(0, len(pts), 128):
            assert upsert("h", pts[i:i + 128], timeout=30)[0] == 200
        green = wait_green("h")
        created = info("h")["created_at"]
        indexes = len(info("h")["payload_schema"])
        sh("docker", "stop", "-t", "20", "r4-h")
        pid = golden_peer_id()
        result("golden-load", attempt=attempt, points=POINTS, seconds_to_green=green, created_at=created, payload_indexes=indexes, peer_id=str(pid))
        if 2.5e15 < pid < 6.5e15:
            break
    sh("docker", "volume", "rm", "-f", "r4-golden", check=False)
    sh("docker", "run", "--rm", "-v", "r4-h-storage:/from", "-v", "r4-golden:/to", UTIL, "sh", "-c", "cp -a /from/. /to/")
    result("golden-saved", h_peer_id=str(pid))


def form(layout):
    sh("docker", "network", "create", "--subnet", "172.31.0.0/24", NET, check=False)
    teardown()
    sh("docker", "volume", "create", "r4-h-storage")
    sh("docker", "run", "--rm", "-v", "r4-golden:/from", "-v", "r4-h-storage:/to", UTIL, "sh", "-c", "cp -a /from/. /to/")
    t0 = time.time()
    start("h", cluster=True)
    after = info("h")
    created = after["created_at"]
    result("form-restart-existing-storage", seconds=round(time.time() - t0, 1), points=count("h"), status=after["status"], created_at=created)
    for k in "ml":
        start(k, cluster=True, bootstrap="h")
    for k in NODE_KEYS:
        shape(k)
    t1 = time.time()
    while time.time() - t1 < 90 and len((cluster("h") or {}).get("peers", {})) < 3:
        time.sleep(1)
    pid = peer_ids()
    result("form-three-peers", seconds=round(time.time() - t1, 1), raft=raft("h"), peers=len(cluster("h")["peers"]), peer_ids={k: str(v) for k, v in pid.items()})
    for dst in ("l",) if layout == "D" else ("l", "m"):
        replicate(dst, layout)
    rf = {"D": 2, "D2": 3}[layout]
    status, body, _ = q("h", "PATCH", "/collections/" + COLLECTION, {"params": {"replication_factor": rf}})
    infos = {k: info(k) for k in NODE_KEYS}
    result("layout-ready", layout=layout, patch_rf=status, created_at_unchanged=all(i["created_at"] == created for i in infos.values()),
           counts={k: count(k) for k in NODE_KEYS}, replicas=replica_states("h"), raft=raft("h"),
           config={k: infos["h"]["config"]["params"][k] for k in ("replication_factor", "write_consistency_factor", "shard_number")})
    alias_check()


def aliases_on(k):
    status, body, _ = q(k, "GET", "/aliases", timeout=5)
    return sorted(a["alias_name"] for a in body["result"]["aliases"]) if status == 200 else None


def alias_check():
    """The alias velora_reel_semantic was created before cluster mode; do the other peers know it?"""
    before = {k: aliases_on(k) for k in NODE_KEYS}
    result("alias-after-formation", aliases=before)
    if any(ALIAS not in (v or []) for v in before.values()):
        status, body, ms = q("h", "POST", "/collections/aliases", {"actions": [
            {"delete_alias": {"alias_name": ALIAS}},
            {"create_alias": {"collection_name": COLLECTION, "alias_name": ALIAS}}]}, timeout=20)
        time.sleep(2)
        result("alias-recreated-through-consensus", status=status, ms=ms, aliases={k: aliases_on(k) for k in NODE_KEYS})


def replicate(dst, layout="?"):
    pid = peer_ids()
    t2 = time.time()
    status, body, ms = q("h", "POST", "/collections/%s/cluster?wait=true" % COLLECTION,
                         {"replicate_shard": {"shard_id": 0, "from_peer_id": pid["h"], "to_peer_id": pid[dst], "method": "snapshot"}}, timeout=60)
    took = wait_converged(300, want=["h", dst])
    result("replicate", layout=layout, to=dst, request_status=status, request_ms=ms, seconds_to_active=round(time.time() - t2, 1), converged=took)


def set_wcf(n):
    status, body, _ = q("h", "PATCH", "/collections/" + COLLECTION, {"params": {"write_consistency_factor": n}})
    return status


def step_latency(layout):
    for wcf in (1, 2):
        result("set-wcf", wcf=wcf, status=set_wcf(wcf))
        time.sleep(1)
        for node in ("h", "l"):
            times, bad, verify_miss, verify_ms = [], 0, 0, []
            for i in range(10):
                pts = fresh_points()
                status, body, ms = upsert(node, pts, timeout=30)
                times.append(ms)
                if status != 200:
                    bad += 1
                    continue
                # the projection worker's verify: count with the tuple filter, then read every point back with vectors
                t = time.time()
                status2, body2, _ = q(node, "POST", "/collections/%s/points" % COLLECTION,
                                      {"ids": [p["id"] for p in pts], "with_payload": True, "with_vector": True}, timeout=10)
                verify_ms.append(round((time.time() - t) * 1000))
                if status2 != 200 or len(body2["result"]) != len(pts):
                    verify_miss += 1
            ok = sorted(times)
            result("write-latency", layout=layout, wcf=wcf, via=node, batches=10, failed=bad, p50=ok[len(ok) // 2], max=ok[-1],
                   over_5s=len([t for t in times if t > 5000]), readback_missing_batches=verify_miss,
                   readback_p50_ms=sorted(verify_ms)[len(verify_ms) // 2] if verify_ms else None)
    set_wcf(1)
    wait_converged(120)


def req_counts(k):
    """Cumulative request counters from /telemetry: REST queries answered here, and internal gRPC
    sub-requests other peers sent here (a remote replica being used shows up as the latter)."""
    status, body, _ = q(k, "GET", "/telemetry?details_level=4", timeout=8)
    if status != 200:
        return None
    reqs = body["result"].get("requests", {})

    def total(o):
        if isinstance(o, dict):
            return o["count"] if "count" in o and not isinstance(o["count"], dict) else sum(total(v) for v in o.values())
        return 0
    rest = sum(total(v) for key, v in reqs.get("rest", {}).get("responses", {}).items() if "points/query" in key)
    internal = sum(total(v) for key, v in reqs.get("grpc", {}).get("responses", {}).items()
                   if "PointsInternal" in key and "Count" not in key)
    return {"rest_query": rest, "grpc_points_internal": internal}


def delta(before, after):
    return {k: ({f: after[k][f] - before[k][f] for f in after[k]} if before[k] and after[k] else None) for k in before}


def scope_ids(n=6000):
    return [p["id"] for p in make_points(n, seed=7)]


def load(nodes, seconds=12, threads=12):
    """Closed-loop exact searches over a 6,000-id scope; request bodies are serialised once so the
    client is not the bottleneck. Queries aimed at l and n pay the simulated client RTT."""
    ids = scope_ids()
    bodies = [json.dumps({"query": v, "params": {"exact": True}, "limit": 5, "with_payload": True, "with_vector": False,
                          "filter": {"must": [{"has_id": ids}, {"key": "kind", "match": {"value": "CHUNK"}}]}}).encode() for v in PROBE_VECS]
    stop = time.time() + seconds
    times, errors, over = [], [0], [0]
    lock = threading.Lock()
    ctr = [0]

    def worker(w):
        while time.time() < stop:
            with lock:
                i = ctr[0]
                ctr[0] += 1
            node = nodes[i % len(nodes)]
            time.sleep(CLIENT_RTT[node])
            request = urllib.request.Request("https://localhost:%d/collections/%s/points/query" % (NODES[node][1], COLLECTION),
                                             data=bodies[i % len(bodies)], method="POST",
                                             headers={"api-key": KEY, "content-type": "application/json"})
            t = time.time()
            try:
                with urllib.request.urlopen(request, context=CTX, timeout=5) as r:
                    r.read()
                ms = round((time.time() - t) * 1000 + CLIENT_RTT[node] * 1000)
                with lock:
                    times.append(ms)
                    over[0] += ms > 250
            except Exception:
                with lock:
                    errors[0] += 1
    ts = [threading.Thread(target=worker, args=(i,)) for i in range(threads)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    times.sort()
    return {"qps": round(len(times) / seconds, 1), "p50": times[len(times) // 2] if times else None,
            "p95": times[int(len(times) * 0.95)] if times else None, "over_250ms": round(over[0] / max(1, len(times)), 3), "errors": errors[0]}


def step_reads(layout):
    ids = scope_ids()
    before = {k: req_counts(k) for k in NODE_KEYS}
    sample = [search("h", PROBE_VECS[i % 12], ids=ids, rtt=True)[2] for i in range(60)]
    sample.sort()
    after = {k: req_counts(k) for k in NODE_KEYS}
    result("reads-sequential-h", layout=layout, queries=60, p50=sample[30], p95=sample[56], max=sample[-1], request_delta=delta(before, after))
    spreads = [("h only", ["h"]), ("m only", ["m"]), ("h+l", ["h", "l"]), ("h+m", ["h", "m"]), ("h+m+l", ["h", "m", "l"])]
    for label, nodes in spreads:
        result("read-throughput", layout=layout, spread=label, replicas=replica_states("h")["states"], **load(nodes))
    q("h", "PATCH", "/collections/" + COLLECTION, {"params": {"read_fan_out_factor": 1}})
    before = {k: req_counts(k) for k in NODE_KEYS}
    sample = sorted(search("h", PROBE_VECS[i % 12], ids=ids, rtt=True)[2] for i in range(40))
    after = {k: req_counts(k) for k in NODE_KEYS}
    result("reads-fanout-1", layout=layout, queries=40, p50=sample[20], max=sample[-1], request_delta=delta(before, after))
    q("h", "PATCH", "/collections/" + COLLECTION, {"params": {"read_fan_out_factor": 0}})


def kill_one(layout, victims, wcf, checkpoints=(3, 15, 40)):
    peer_ids()
    survivors = [k for k in NODES if k not in victims]
    before = {"raft": raft(survivors[0]), "replicas": replica_states(survivors[0])}
    result("kill-start", layout=layout, wcf=wcf, victims=victims, raft_leader=before["raft"]["leader"], replicas=before["replicas"]["states"],
           highest_peer_id_overall=max(PID, key=lambda x: PID[x]),
           highest_peer_id_among_replica_holders=max(before["replicas"]["states"], key=lambda x: PID[x]))
    for v in victims:
        sh("docker", "kill", "r4-" + v)
    t0 = time.time()
    for checkpoint in checkpoints:
        time.sleep(max(0, t0 + checkpoint - time.time()))
        row = {"t": checkpoint}
        for k in survivors:
            row["search_" + k] = probe(k, 2)
        for k in survivors:
            status, body, ms = upsert(k, fresh_points(), timeout=12)
            row["write_" + k] = "%s %dms%s" % (status, ms, "" if status == 200 else " " + re.sub(r"\s+", " ", str(body))[:90])
        if checkpoint == checkpoints[1]:
            for ordering in ("medium",):
                for k in survivors:
                    status, body, ms = upsert(k, fresh_points(), ordering=ordering, timeout=12)
                    row["write_%s_%s" % (ordering, k)] = "%s %dms" % (status, ms)
        if checkpoint in checkpoints[1:]:
            status, body, ms = q(survivors[0], "POST", "/collections/aliases", {"actions": [{"create_alias": {
                "collection_name": COLLECTION, "alias_name": "r4_probe_%d_%s" % (checkpoint, "".join(victims))}}]}, timeout=15)
            row["topology_alias"] = "%s %dms %s" % (status, ms, "" if status == 200 else re.sub(r"\s+", " ", str(body))[:80])
        row["raft"] = {k: raft(k) for k in survivors}
        row["replicas"] = replica_states(survivors[0])
        result("kill-checkpoint", layout=layout, wcf=wcf, victims=victims, **row)
    t1 = time.time()
    for v in victims:
        start(v, cluster=True, bootstrap=survivors[0])
        shape(v)
    ready = round(time.time() - t1, 1)
    converged = wait_converged(300)
    result("kill-recovery", layout=layout, wcf=wcf, victims=victims, restart_to_ready_s=ready, converged_after_restart_s=converged,
           counts={k: count(k) for k in NODE_KEYS}, raft=raft("h"))


def step_kills(layout, wcf=1):
    set_wcf(wcf)
    time.sleep(1)
    wait_converged(120)
    for victims in (["h"], ["m"], ["l"], ["h", "m"]):
        kill_one(layout, victims, wcf)
    set_wcf(1)


def reroll(k, pred, layout, tries=14):
    """Give node k a new random peer id until pred(ids) holds. Removes the peer, wipes it, rejoins, re-replicates if it holds a copy."""
    for attempt in range(1, tries + 1):
        peer_ids()
        if pred(PID):
            return True
        holds = k in (replica_states("h") or {"states": {}})["states"]
        sh("docker", "kill", "r4-" + k)
        time.sleep(2)
        q("h", "DELETE", "/cluster/peer/%s?force=true" % PID[k], timeout=25)
        sh("docker", "rm", "-f", "r4-" + k, check=False)
        for suffix in ("storage", "snapshots"):
            sh("docker", "volume", "rm", "-f", "r4-%s-%s" % (k, suffix), check=False)
        start(k, cluster=True, bootstrap="h")
        shape(k)
        time.sleep(3)
        peer_ids()
        if holds:
            replicate(k, layout)
    peer_ids()
    return pred(PID)


def step_ids(layout):
    """Is the strict-write failure tied to the highest peer id among replica holders or among all peers?
    Layout D: holders are h and l; m holds no replica."""
    cases = {
        "X: m highest of all, h highest holder (m > h > l)": (lambda p: p["m"] > p["h"] > p["l"], ["m", "l", "h"]),
        "Y: l highest of all and of the holders (l > h > m)": (lambda p: p["l"] > p["h"] > p["m"], ["l", "m", "h"]),
    }
    for name, (pred, victims) in cases.items():
        # re-roll m and l independently until the whole order holds
        for attempt in range(1, 14):
            peer_ids()
            if pred(PID):
                break
            if name.startswith("X"):
                if PID["m"] < PID["h"]:
                    reroll("m", lambda p: p["m"] > p["h"], layout)
                elif PID["l"] > PID["h"]:
                    reroll("l", lambda p: p["l"] < p["h"], layout)
            else:
                if PID["l"] < PID["h"]:
                    reroll("l", lambda p: p["l"] > p["h"], layout)
                elif PID["m"] > PID["h"]:
                    reroll("m", lambda p: p["m"] < p["h"], layout)
        peer_ids()
        result("id-order", case=name, achieved=pred(PID), ids={k: str(v) for k, v in PID.items()})
        if not pred(PID):
            continue
        wait_converged(120)
        for v in victims:
            kill_one(layout, [v], 1, checkpoints=(3, 15))


def step_failover(layout):
    """Host loss: H1 and H2 die for good. Bring the laptop node back as a standalone writable Qdrant."""
    peer_ids()
    wait_converged(120)
    before = {"created_at": info("l")["created_at"], "count": count("l"), "aliases": aliases_on("l")}
    result("failover-before", layout=layout, **before)
    sh("docker", "kill", "r4-h", "r4-m")
    t0 = time.time()
    time.sleep(10)
    status, body, ms = upsert("l", fresh_points(), timeout=12)
    result("failover-laptop-in-cluster-mode", write="%s %dms %s" % (status, ms, re.sub(r"\s+", " ", str(body))[:80]),
           search=probe("l", 2), raft=raft("l"),
           topology=q("l", "POST", "/collections/aliases", {"actions": [{"create_alias": {"collection_name": COLLECTION, "alias_name": "r4_probe"}}]}, timeout=12)[0])
    # manual procedure, step 1: stop the laptop node
    t1 = time.time()
    sh("docker", "stop", "-t", "20", "r4-l")
    stopped = round(time.time() - t1, 1)
    # step 2: drop the dead peers from the local replica set (offline edit, original kept)
    t2 = time.time()
    sh("docker", "run", "--rm", "-v", "r4-l-storage:/s", UTIL, "sh", "-c",
       "f=$(ls /s/collections/%s/0/replica_state.json) && cp $f $f.orig && "
       "jq -c '. as $r | .peers |= with_entries(select(.key == ($r.this_peer_id|tostring)))' $f.orig > $f && cat $f" % COLLECTION)
    edited = round(time.time() - t2, 1)
    # step 3: start the same storage with cluster mode off
    t3 = time.time()
    start("l", cluster=False)
    ready = round(time.time() - t3, 1)
    green = wait_green("l")
    i = info("l")
    aliases = aliases_on("l")
    # step 4: the alias may be missing (it predates cluster mode): create it
    alias_status = None
    if ALIAS not in (aliases or []):
        alias_status = q("l", "POST", "/collections/aliases", {"actions": [{"create_alias": {"collection_name": COLLECTION, "alias_name": ALIAS}}]})[0]
    w = [upsert("l", fresh_points(), timeout=12) for _ in range(3)]
    ident = {"alias_ok": any(a == ALIAS for a in (aliases_on("l") or [])), "status": i["status"],
             "quantization": i["config"].get("quantization_config"), "vectors": i["config"]["params"]["vectors"]}
    result("failover-standalone", layout=layout, stop_seconds=stopped, edit_seconds=edited, ready_seconds=ready, seconds_to_green=green,
           total_from_host_loss_s=round(time.time() - t0, 1), total_manual_steps_s=round(time.time() - t1, 1),
           created_at_unchanged=i["created_at"] == before["created_at"], count_before=before["count"], count_now=count("l"),
           aliases_before=before["aliases"], alias_create_status=alias_status, identity=ident,
           search=probe("l", 3), strong_writes=["%s %dms" % (x[0], x[2]) for x in w], cluster_api=q("l", "GET", "/cluster")[1]["result"],
           replica_set=replica_states("l") if False else q("l", "GET", "/collections/%s/cluster" % COLLECTION)[1]["result"])


def step_order(layout):
    """Holder order that keeps writes alive when the laptop is lost: h must hold the highest peer id among replica holders."""
    ok = reroll("l", lambda p: p["l"] < p["h"], layout)
    peer_ids()
    result("holder-order", h_highest_holder=ok, ids={k: str(v) for k, v in PID.items()})


def step_away():
    """The laptop goes away for 60 s (container killed), then returns."""
    sh("docker", "kill", "r4-l")
    t0 = time.time()
    rows = []
    while time.time() - t0 < 60:
        status, body, ms = upsert("h", fresh_points(), timeout=12)
        rows.append((round(time.time() - t0), "%s %dms" % (status, ms), probe("h", 1)["ok"], (raft("h") or {}).get("leader")))
        time.sleep(8)
    status, body, ms = q("h", "POST", "/collections/aliases", {"actions": [{"create_alias": {"collection_name": COLLECTION, "alias_name": "r4_laptop_away"}}]}, timeout=15)
    result("laptop-away-60s", samples=rows, topology_alias="%s %dms" % (status, ms), replicas=replica_states("h"))
    t1 = time.time()
    start("l", cluster=True, bootstrap="h")
    shape("l")
    ready = round(time.time() - t1, 1)
    result("laptop-back", ready_s=ready, converged_s=wait_converged(300), counts={k: count(k) for k in NODE_KEYS}, raft=raft("h"))


def phase_raft(layout):
    """10 minutes of idle plus load under the laptop-link emulation (spikes to 40 ms for 3 s every 30 s), then the laptop away for 60 s."""
    for k in NODE_KEYS:
        shape(k)
    peer_ids()
    stop = time.time() + 600
    log = {k: [] for k in NODE_KEYS}
    stats = {"writes": 0, "write_fail": 0, "write_ms": []}

    def writer():
        time.sleep(180)
        end = time.time() + 300
        while time.time() < min(stop, end):
            status, body, ms = upsert("h", fresh_points(), timeout=12)
            stats["writes"] += 1
            stats["write_ms"].append(ms)
            stats["write_fail"] += status != 200
            time.sleep(2)

    def peaks():
        while time.time() < stop:
            time.sleep(27)
            for k in "hm":
                set_delay("l", k, 40, 5)
                set_delay(k, "l", 40, 5)
            time.sleep(3)
            for k in "hm":
                set_delay("l", k, 6, 3)
                set_delay(k, "l", 6, 3)
    threads = [threading.Thread(target=writer), threading.Thread(target=peaks)]
    [t.start() for t in threads]
    result("raft-start", state={k: raft(k) for k in NODE_KEYS})
    while time.time() < stop:
        for k in NODE_KEYS:
            r = raft(k)
            if r:
                log[k].append((round(time.time() - (stop - 600)), r["term"], r["leader"], r["role"]))
        time.sleep(5)
    [t.join() for t in threads]
    summary = {}
    for k in NODE_KEYS:
        terms = [x[1] for x in log[k]]
        leaders = [x[2] for x in log[k]]
        summary[k] = {"samples": len(log[k]), "term_first": terms[0] if terms else None, "term_last": terms[-1] if terms else None,
                      "leader_changes": sum(1 for a, b in zip(leaders, leaders[1:]) if a != b), "no_leader_samples": leaders.count(None)}
    result("raft-ten-minutes", summary=summary, writes=stats["writes"], write_failures=stats["write_fail"],
           write_p50=sorted(stats["write_ms"])[len(stats["write_ms"]) // 2] if stats["write_ms"] else None,
           write_max=max(stats["write_ms"]) if stats["write_ms"] else None,
           send_failures={k: (cluster(k) or {}).get("message_send_failures") for k in NODE_KEYS})
    step_away()


def main():
    if CMD == "golden":
        phase_golden()
    elif CMD == "layout":
        layout = sys.argv[3]
        steps = (sys.argv[4] if len(sys.argv) > 4 else "form,latency,reads,kills").split(",")
        result("layout", layout=layout, steps=steps)
        peer_ids()
        for step in steps:
            result("step", name=step)
            {"form": lambda: form(layout), "latency": lambda: step_latency(layout), "reads": lambda: step_reads(layout),
             "kills": lambda: step_kills(layout, 1), "kills2": lambda: step_kills(layout, 2), "ids": lambda: step_ids(layout),
             "failover": lambda: step_failover(layout), "order": lambda: step_order(layout),
             "away": lambda: step_away()}[step]()
    elif CMD == "raft":
        phase_raft(sys.argv[3] if len(sys.argv) > 3 else "D")
    elif CMD == "cleanup":
        teardown()
        sh("docker", "volume", "rm", "-f", "r4-golden", check=False)
        sh("docker", "network", "rm", NET, check=False)


main()
