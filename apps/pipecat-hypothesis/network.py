import os


def elevenlabs_proxy():
    proxy = os.environ.get("ELEVENLABS_PROXY_URL")
    # Node supports socks5:// with remote DNS; httpx names it socks5h://.
    return proxy or None


def elevenlabs_http_options():
    proxy = elevenlabs_proxy()
    return {"proxy": proxy.replace("socks5://", "socks5h://", 1)} if proxy else {}


def voximplant_http_options():
    proxy = os.environ.get("PIPECAT_VOX_PROXY_URL")
    return {"proxy": proxy.replace("socks5://", "socks5h://", 1)} if proxy else {}
