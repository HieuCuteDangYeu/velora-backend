#!/usr/bin/env python3
"""Disposable THREE-node Qdrant cluster rehearsal (stdlib only, needs docker).

Nodes: h = homelab (main, the node the indexers talk to), l = homelab 2 laptop, n = velora-node-2.
Latency is emulated with netem on each node's egress (one-way ms, so RTT is double):
  h<->l 6 ms (jitter 3), h<->n 108 ms (jitter 10), l<->n 115 ms (jitter 10), 25 % correlation.
Node n gets 0.5 CPU (a node-2 vCPU is about a third of an M1 core), h and l get 1 CPU, all 768 MB.

Usage: rehearse3.py <secrets-dir> golden
       rehearse3.py <secrets-dir> layout <A|B|C> [step,step,...]    steps: form latency reads kills1 kills2 lost
       rehearse3.py <secrets-dir> raft
Layouts: A replicas on h, l and n (replication_factor 3); B replicas on h and l, n is a data-less
voter; C replicas on h and n, l is a data-less voter (replication_factor 2).
Everything is disposable (containers r3-*, network r3-net, volumes r3-*). One JSON line per
measurement, prefixed RESULT.
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
NET = "r3-net"
NODES = {"h": ("172.30.0.11", 6443, 1.0), "l": ("172.30.0.12", 6444, 1.0), "n": ("172.30.0.13", 6445, 0.5)}
DELAY = {("h", "l"): (6, 3), ("h", "n"): (108, 10), ("l", "n"): (115, 10)}
CLIENT_RTT = {"h": 0.0, "l": 0.012, "n": 0.217}  # simulated client (on the homelab) to node RTT, seconds
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
    name = "r3-" + k
    sh("docker", "rm", "-f", name, check=False)
    ip, port, cpus = NODES[k]
    env = ["-e", "QDRANT__CLUSTER__ENABLED=true", "-e", "QDRANT__CLUSTER__P2P__ENABLE_TLS=true"] if cluster else []
    args = ["--uri", "https://r3-%s:6335" % k] if cluster else []
    if bootstrap:
        args += ["--bootstrap", "https://r3-%s:6335" % bootstrap]
    sh("docker", "run", "-d", "--name", name, "--network", NET, "--ip", ip, "--network-alias", "r3-" + k,
       "-p", "127.0.0.1:%d:6333" % port, "--cpus", str(cpus), "--memory", "768m", "--entrypoint", "bash", *env,
       "-v", "r3-%s-storage:/qdrant/storage" % k, "-v", "r3-%s-snapshots:/qdrant/snapshots" % k,
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
    sh("docker", "run", "--rm", "--cap-add", "NET_ADMIN", "--network", "container:r3-" + k, UTIL, "sh", "-c", script, check=False)


def delay_for(a, b):
    return DELAY.get((a, b)) or DELAY[(b, a)]


def shape(k):
    cmds = ["tc qdisc del dev eth0 root 2>/dev/null",
            "tc qdisc add dev eth0 root handle 1: prio bands 4 priomap 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3"]
    for band, peer in enumerate([p for p in NODES if p != k], start=1):
        d, j = delay_for(k, peer)
        cmds.append("tc qdisc add dev eth0 parent 1:%d handle %d0: netem delay %dms %dms 25%%" % (band, band, d, j))
        cmds.append("tc filter add dev eth0 protocol ip parent 1:0 prio 1 u32 match ip dst %s flowid 1:%d" % (NODES[peer][0], band))
    tc(k, "; ".join(cmds))


def set_delay(k, peer, d, j):
    band = [p for p in NODES if p != k].index(peer) + 1
    tc(k, "tc qdisc change dev eth0 parent 1:%d handle %d0: netem delay %dms %dms 25%%" % (band, band, d, j))


def teardown():
    for k in NODES:
        sh("docker", "rm", "-f", "r3-" + k, check=False)
    for k in NODES:
        for suffix in ("storage", "snapshots"):
            sh("docker", "volume", "rm", "-f", "r3-%s-%s" % (k, suffix), check=False)


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
        if c:
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
    return [k for k in NODES if sh("docker", "inspect", "-f", "{{.State.Running}}", "r3-" + k, check=False) == "true"]


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
def phase_golden():
    teardown()
    sh("docker", "network", "create", "--subnet", "172.30.0.0/24", NET, check=False)
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
    result("golden-load", points=count("h"), seconds_to_green=wait_green("h"), created_at=info("h")["created_at"],
           payload_indexes=len(info("h")["payload_schema"]))
    sh("docker", "stop", "-t", "20", "r3-h")
    sh("docker", "volume", "rm", "-f", "r3-golden", check=False)
    sh("docker", "run", "--rm", "-v", "r3-h-storage:/from", "-v", "r3-golden:/to", UTIL, "sh", "-c", "cp -a /from/. /to/")
    result("golden-saved")


def form(layout):
    sh("docker", "network", "create", "--subnet", "172.30.0.0/24", NET, check=False)
    teardown()
    sh("docker", "volume", "create", "r3-h-storage")
    sh("docker", "run", "--rm", "-v", "r3-golden:/from", "-v", "r3-h-storage:/to", UTIL, "sh", "-c", "cp -a /from/. /to/")
    created = None
    t0 = time.time()
    start("h", cluster=True)
    after = info("h")
    result("form-restart-existing-storage", seconds=round(time.time() - t0, 1), points=count("h"), status=after["status"],
           created_at=after["created_at"])
    created = after["created_at"]
    for k in "ln":
        start(k, cluster=True, bootstrap="h")
    for k in "hln":
        shape(k)
    t1 = time.time()
    while time.time() - t1 < 90 and len((cluster("h") or {}).get("peers", {})) < 3:
        time.sleep(1)
    peer_ids()
    result("form-three-peers", seconds=round(time.time() - t1, 1), raft=raft("h"), peers=len(cluster("h")["peers"]))
    pid = peer_ids()
    plan = {"A": [("h", "l"), ("h", "n")], "B": [("h", "l")], "C": [("h", "n")]}[layout]
    for src, dst in plan:
        t2 = time.time()
        status, body, ms = q("h", "POST", "/collections/%s/cluster?wait=true" % COLLECTION,
                             {"replicate_shard": {"shard_id": 0, "from_peer_id": pid[src], "to_peer_id": pid[dst], "method": "snapshot"}}, timeout=60)
        took = wait_converged(300, want=["h", dst])
        result("replicate", layout=layout, to=dst, request_status=status, request_ms=ms, seconds_to_active=round(time.time() - t2, 1), converged=took)
    rf = {"A": 3, "B": 2, "C": 2}[layout]
    status, body, _ = q("h", "PATCH", "/collections/" + COLLECTION, {"params": {"replication_factor": rf}})
    ia, ib = info("h"), info("n") if layout in "AC" else info("l")
    result("layout-ready", layout=layout, patch_rf=status, created_at_unchanged=created == ia["created_at"] and created == ib["created_at"],
           counts={k: count(k) for k in "hln"}, replicas=replica_states("h"), raft=raft("h"),
           config={k: ia["config"]["params"][k] for k in ("replication_factor", "write_consistency_factor", "shard_number")})


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
    before = {k: req_counts(k) for k in "hln"}
    sample = [search("h", PROBE_VECS[i % 12], ids=ids, rtt=True)[2] for i in range(60)]
    sample.sort()
    after = {k: req_counts(k) for k in "hln"}
    result("reads-sequential-h", layout=layout, queries=60, p50=sample[30], p95=sample[56], max=sample[-1], request_delta=delta(before, after))
    for label, nodes in (("h only", ["h"]), ("h+l", ["h", "l"]), ("h+l+n", ["h", "l", "n"])):
        result("read-throughput", layout=layout, spread=label, replicas=replica_states("h")["states"], **load(nodes))
    q("h", "PATCH", "/collections/" + COLLECTION, {"params": {"read_fan_out_factor": 1}})
    before = {k: req_counts(k) for k in "hln"}
    sample = sorted(search("h", PROBE_VECS[i % 12], ids=ids, rtt=True)[2] for i in range(40))
    after = {k: req_counts(k) for k in "hln"}
    result("reads-fanout-1", layout=layout, queries=40, p50=sample[20], max=sample[-1], request_delta=delta(before, after))
    q("h", "PATCH", "/collections/" + COLLECTION, {"params": {"read_fan_out_factor": 0}})


def kill_one(layout, victim, wcf):
    peer_ids()
    before = {"raft": raft("h") if victim != "h" else raft("l"), "replicas": replica_states("h" if victim != "h" else "l")}
    result("kill-start", layout=layout, wcf=wcf, victim=victim, raft_leader=before["raft"]["leader"], replicas=before["replicas"]["states"],
           highest_peer_id=max(PID, key=lambda x: PID[x]))
    sh("docker", "kill", "r3-" + victim)
    t0 = time.time()
    survivors = [k for k in NODES if k != victim]
    for checkpoint in (3, 12, 30, 60):
        time.sleep(max(0, t0 + checkpoint - time.time()))
        row = {"t": checkpoint}
        for k in survivors:
            row["search_" + k] = probe(k, 2)
        for k in survivors:
            status, body, ms = upsert(k, fresh_points(), timeout=12)
            row["write_" + k] = "%s %dms%s" % (status, ms, "" if status == 200 else " " + re.sub(r"\s+", " ", str(body))[:90])
        if checkpoint == 12:
            for ordering in ("medium", "weak"):
                for k in survivors:
                    status, body, ms = upsert(k, fresh_points(), ordering=ordering, timeout=12)
                    row["write_%s_%s" % (ordering, k)] = "%s %dms%s" % (status, ms, "" if status == 200 else " " + re.sub(r"\s+", " ", str(body))[:70])
        if checkpoint in (12, 60):
            status, body, ms = q(survivors[0], "POST", "/collections/aliases", {"actions": [{"create_alias": {
                "collection_name": COLLECTION, "alias_name": "r3_probe_%d_%s" % (checkpoint, victim)}}]}, timeout=15)
            row["topology_alias"] = "%s %dms %s" % (status, ms, "" if status == 200 else re.sub(r"\s+", " ", str(body))[:80])
        row["raft"] = {k: raft(k) for k in survivors}
        row["replicas"] = replica_states(survivors[0])
        result("kill-checkpoint", layout=layout, wcf=wcf, victim=victim, **row)
    t1 = time.time()
    start(victim, cluster=True, bootstrap="h" if victim != "h" else "l")
    shape(victim)
    ready = round(time.time() - t1, 1)
    converged = wait_converged(300)
    result("kill-recovery", layout=layout, wcf=wcf, victim=victim, restart_to_ready_s=ready, converged_after_restart_s=converged,
           counts={k: count(k) for k in "hln"}, raft=raft("h"))


def step_kills(layout, wcf):
    set_wcf(wcf)
    time.sleep(1)
    wait_converged(120)
    for victim in ("h", "l", "n"):
        kill_one(layout, victim, wcf)
    set_wcf(1)


def step_ordering(layout):
    """Which node leads strong-ordered writes? Kill the one with the highest peer id and compare orderings."""
    peer_ids()
    victim = max(PID, key=lambda k: PID[k])
    result("ordering-victim", layout=layout, victim=victim, peer_ids={k: str(v) for k, v in PID.items()})
    kill_one(layout, victim, 1)


def step_order(layout):
    """Strong-ordered writes need the replica with the highest peer id. Re-roll l (remove, wipe,
    rejoin as a new peer, re-replicate) until its id is lower than h's, so that h leads writes."""
    for attempt in range(1, 10):
        peer_ids()
        result("peer-ids", layout=layout, attempt=attempt, ids={k: str(v) for k, v in PID.items()}, l_below_h=PID["l"] < PID["h"])
        if PID["l"] < PID["h"]:
            return
        sh("docker", "kill", "r3-l")
        time.sleep(3)
        status, body, ms = q("h", "DELETE", "/cluster/peer/%s?force=true" % PID["l"], timeout=25)
        result("reroll-remove-l", status=status, ms=ms)
        sh("docker", "rm", "-f", "r3-l", check=False)
        for suffix in ("storage", "snapshots"):
            sh("docker", "volume", "rm", "-f", "r3-l-" + suffix, check=False)
        start("l", cluster=True, bootstrap="h")
        shape("l")
        time.sleep(5)
        peer_ids()
        q("h", "POST", "/collections/%s/cluster?wait=true" % COLLECTION,
          {"replicate_shard": {"shard_id": 0, "from_peer_id": PID["h"], "to_peer_id": PID["l"], "method": "snapshot"}}, timeout=60)
        result("reroll-converged", seconds=wait_converged(120))


def step_lost(layout):
    """Permanent loss of one node: can it be removed, with and without force; then rebuild it."""
    for victim in ("n", "l"):
        peer_ids()
        wait_converged(180)
        pid = dict(PID)
        survivors = [k for k in NODES if k != victim]
        sh("docker", "kill", "r3-" + victim)
        time.sleep(5)
        holds = victim in (replica_states(survivors[0]) or {"states": {}})["states"]
        r = {}
        for label, path in (("plain", "/cluster/peer/%s" % pid[victim]), ("force", "/cluster/peer/%s?force=true" % pid[victim])):
            status, body, ms = q(survivors[0], "DELETE", path, timeout=25)
            r[label] = "%s %dms %s" % (status, ms, re.sub(r"\s+", " ", str(body))[:110])
        if holds:
            status, body, ms = q(survivors[0], "POST", "/collections/%s/cluster" % COLLECTION,
                                 {"drop_replica": {"shard_id": 0, "peer_id": pid[victim]}}, timeout=25)
            r["drop_replica"] = "%s %dms %s" % (status, ms, re.sub(r"\s+", " ", str(body))[:110])
            status, body, ms = q(survivors[0], "DELETE", "/cluster/peer/%s?force=true" % pid[victim], timeout=25)
            r["force_after_drop"] = "%s %dms %s" % (status, ms, re.sub(r"\s+", " ", str(body))[:110])
        time.sleep(3)
        w = [upsert(k, fresh_points(), timeout=12) for k in survivors]
        result("permanent-loss", layout=layout, victim=victim, victim_held_replica=holds, removal=r,
               writes_after={k: "%s %dms" % (x[0], x[2]) for k, x in zip(survivors, w)},
               search_after={k: probe(k, 2) for k in survivors}, peers_after={k: (cluster(k) or {}).get("peers", {}).keys() and len(cluster(k)["peers"]) for k in survivors},
               raft_after={k: raft(k) for k in survivors})
        # restore: a removed peer must be wiped and rejoin as a new peer; a peer that could not be
        # removed comes back with its old storage
        removed = "200" in r.get("force", "") or "200" in r.get("force_after_drop", "")
        old_ready = None
        if removed:
            sh("docker", "rm", "-f", "r3-" + victim, check=False)
            for suffix in ("storage", "snapshots"):
                sh("docker", "volume", "rm", "-f", "r3-%s-%s" % (victim, suffix), check=False)
        else:
            sh("docker", "start", "r3-" + victim, check=False)
        try:
            start(victim, cluster=True, bootstrap=survivors[0]) if removed else wait_ready(victim)
            shape(victim)
        except RuntimeError:
            old_ready = "not ready"
        time.sleep(8)
        rejoin = {}
        if removed and victim in ("l", "n") and holds:
            peer_ids()
            t = time.time()
            status, body, ms = q(survivors[0], "POST", "/collections/%s/cluster?wait=true" % COLLECTION,
                                 {"replicate_shard": {"shard_id": 0, "from_peer_id": PID[survivors[0]], "to_peer_id": PID[victim], "method": "snapshot"}}, timeout=60)
            rejoin = {"replicate_status": status, "seconds": None}
            rejoin["converged"] = wait_converged(300)
            rejoin["seconds"] = round(time.time() - t, 1)
        result("permanent-loss-restore", layout=layout, victim=victim, removed_from_cluster=removed, rejoin_as_new_peer=rejoin,
               old_storage_ready=old_ready, raft=raft(survivors[0]), peers=len((cluster(survivors[0]) or {}).get("peers", {})),
               replicas=replica_states(survivors[0]))


def phase_raft():
    """10 minutes idle plus load: count term changes and leader changes with the default Raft settings."""
    for k in "hln":
        shape(k)
    peer_ids()
    stop = time.time() + 600
    log = {k: [] for k in "hln"}
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
        # laptop Wi-Fi peaks: 40 ms one-way for 3 s every 30 s
        while time.time() < stop:
            time.sleep(27)
            set_delay("l", "h", 40, 5)
            time.sleep(3)
            set_delay("l", "h", 6, 3)
    threads = [threading.Thread(target=writer), threading.Thread(target=peaks)]
    [t.start() for t in threads]
    first = {k: raft(k) for k in "hln"}
    result("raft-start", state=first)
    while time.time() < stop:
        for k in "hln":
            r = raft(k)
            if r:
                log[k].append((round(time.time() - (stop - 600)), r["term"], r["leader"], r["role"]))
        time.sleep(5)
    [t.join() for t in threads]
    summary = {}
    for k in "hln":
        terms = [x[1] for x in log[k]]
        leaders = [x[2] for x in log[k]]
        summary[k] = {"samples": len(log[k]), "term_first": terms[0] if terms else None, "term_last": terms[-1] if terms else None,
                      "leader_changes": sum(1 for a, b in zip(leaders, leaders[1:]) if a != b), "no_leader_samples": leaders.count(None)}
    c = cluster("h")
    result("raft-ten-minutes", summary=summary, writes=stats["writes"], write_failures=stats["write_fail"],
           write_p50=sorted(stats["write_ms"])[len(stats["write_ms"]) // 2] if stats["write_ms"] else None,
           write_max=max(stats["write_ms"]) if stats["write_ms"] else None,
           send_failures={k: (cluster(k) or {}).get("message_send_failures") for k in "hln"})


def phase_rollback():
    """Cluster mode on existing storage, then back to single node: is the collection intact?"""
    sh("docker", "network", "create", "--subnet", "172.30.0.0/24", NET, check=False)
    teardown()
    sh("docker", "volume", "create", "r3-h-storage")
    sh("docker", "run", "--rm", "-v", "r3-golden:/from", "-v", "r3-h-storage:/to", UTIL, "sh", "-c", "cp -a /from/. /to/")
    before = None
    start("h", cluster=False)
    before = info("h")["created_at"], count("h")
    sh("docker", "stop", "-t", "20", "r3-h")
    t0 = time.time()
    start("h", cluster=True)
    mid = info("h")["created_at"], count("h"), (cluster("h") or {}).get("status")
    result("cluster-on", seconds=round(time.time() - t0, 1), created_at_same=mid[0] == before[0], count=mid[1], cluster=mid[2])
    sh("docker", "stop", "-t", "20", "r3-h")
    t0 = time.time()
    start("h", cluster=False)
    after = info("h")
    result("cluster-off-again", seconds=round(time.time() - t0, 1), created_at_same=after["created_at"] == before[0], count=count("h"),
           status=after["status"], probes=probe("h", 3), cluster_api=q("h", "GET", "/cluster")[1] if True else None)
    teardown()


def main():
    if CMD == "rollback":
        phase_rollback()
    elif CMD == "golden":
        phase_golden()
    elif CMD == "layout":
        layout = sys.argv[3]
        steps = (sys.argv[4] if len(sys.argv) > 4 else "form,latency,reads,kills1,kills2,lost").split(",")
        result("layout", layout=layout, steps=steps)
        peer_ids()
        for s in steps:
            result("step", name=s)
            {"form": lambda: form(layout), "latency": lambda: step_latency(layout), "reads": lambda: step_reads(layout),
             "kills1": lambda: step_kills(layout, 1), "kills2": lambda: step_kills(layout, 2), "lost": lambda: step_lost(layout),
             "ordering": lambda: step_ordering(layout), "order": lambda: step_order(layout)}[s]()
    elif CMD == "raft":
        phase_raft()


main()
