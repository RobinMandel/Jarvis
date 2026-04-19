import asyncio
import json
import sys

import aiohttp


async def main(action: str, session_id: str):
    msg_type = {"cancel": "chat.cancel", "delete": "chat.delete_session"}[action]
    done_types = {"cancel": ("chat.cancelled",), "delete": ("chat.sessions",)}[action]
    async with aiohttp.ClientSession() as session:
        async with session.ws_connect("http://localhost:8090/ws/chat") as ws:
            await ws.send_json({"type": msg_type, "session_id": session_id})
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                data = json.loads(msg.data)
                if data.get("type") in done_types or data.get("type") == "chat.error":
                    print(data.get("type"))
                    return


if __name__ == "__main__":
    asyncio.run(asyncio.wait_for(main(sys.argv[1], sys.argv[2]), timeout=5))
