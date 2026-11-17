"""Container readiness check; never print the shared authentication secret."""
import os
import urllib.request

request = urllib.request.Request("http://127.0.0.1:8093/health", headers={
    "Authorization": "Bearer " + os.environ.get("PIPECAT_HYPOTHESIS_TOKEN", ""),
})
with urllib.request.urlopen(request, timeout=4) as response:
    if response.status != 200:
        raise SystemExit(1)
