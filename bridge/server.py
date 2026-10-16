"""Pinned upstream tools with local auth, metadata and fail-closed error boundaries."""
import asyncio
import base64
import functools
import hashlib
import html
import importlib.util
import io
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("bilibili_upstream", ROOT / "vendor/bilibili-mcp/mcp_server.py")
upstream = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upstream)
import qrcode
from bilibili_api import search, video, comment, user, login_v2, Credential
from bilibili_api.exceptions import NetworkException
from bilibili_api.utils.network import Api, get_client

logging.disable(logging.CRITICAL)  # SDK diagnostics may contain request credentials.
upstream.CRED_FILE = Path(os.environ.get("BILI_CREDENTIAL_FILE", ROOT / "data/config/bili_credential.json"))
QR_API = login_v2.API["qrcode"]["web"]
LOGIN_COOKIES = ("SESSDATA", "bili_jct", "DedeUserID")
RENEW_INTERVAL = 12 * 3600
WRITES = {"bili_reply", "bili_send_dynamic", "bili_upload_video", "bili_upload_video_multi", "bili_send_opus", "bili_send_message"}
TOOLS = ["bili_login", "bili_login_check", "bili_check_credential", "bili_search", "bili_comments", "bili_subtitle", "bili_danmaku", "bili_video_info", "bili_reply", "bili_crawl", "bili_send_dynamic", "bili_upload_video", "bili_upload_video_multi", "bili_send_opus", "bili_video_zones", "bili_hot_videos", "bili_hot_buzzwords", "bili_weekly_hot", "bili_rank", "bili_user_info", "bili_user_videos", "bili_favorite_lists", "bili_favorite_content", "bili_send_message", "bili_unread_messages", "bili_received_replies", "bili_received_at_and_likes"]
lock = asyncio.Lock()
active_operations = {}
qr_session = None
# Per bridge process: the first login check after start or a new login asks Bilibili, then every 12 hours.
next_renewal = 0.0
renewal = None


def error_kind(value):
    if isinstance(value, NetworkException) and value.status in (403, 412):
        return "risk"
    text = str(value).lower()
    # Upstream handlers can serialize NetworkException before this boundary sees it.
    if re.search(r"(?:状态码|http(?:\s+status)?)[：:\s]*(?:403|412)\b", text):
        return "risk"
    if any(word in text for word in ("-412", "-352", "-509", "12002", "22015", "22014", "验证码", "风控", "captcha", "risk", "访问权限不足", "请求被拦截")):
        return "risk"
    if any(word in text for word in ("-101", "未登录", "登录失效", "not logged")):
        return "auth"
    # Permission denials and unknown API failures are not permission to keep writing.
    if any(word in text for word in ("-403", "-404", "禁止", "封禁")):
        return "risk"
    return "api"


def scrub(value):
    secrets = {}
    if upstream.CRED_FILE.exists():
        secrets = json.loads(upstream.CRED_FILE.read_text())
    def clean(item):
        if isinstance(item, dict):
            return {k: clean(v) for k, v in item.items() if k.lower() not in ("sessdata", "bili_jct", "cookie", "token", "refresh_token", "ac_time_value", "buvid3")}
        if isinstance(item, list):
            return [clean(v) for v in item]
        if isinstance(item, str):
            for secret in secrets.values():
                if isinstance(secret, str) and len(secret) >= 4:
                    item = item.replace(secret, "[REDACTED]")
        return item
    return clean(value)


def load_saved():
    """The private credential, including the web refresh_token (ac_time_value) upstream ignores."""
    if not upstream.CRED_FILE.exists():
        return None, {}
    saved = json.loads(upstream.CRED_FILE.read_text())
    cred = Credential(sessdata=saved.get("sessdata", ""), bili_jct=saved.get("bili_jct", ""), buvid3=saved.get("buvid3") or "", dedeuserid=saved.get("dedeuserid", ""), ac_time_value=saved.get("ac_time_value") or "")
    return cred, saved


async def renew(cred, saved):
    """Refresh the web cookie only when Bilibili asks; failures keep the current cookie and wait an interval."""
    global next_renewal, renewal
    if not cred.has_ac_time_value() or time.monotonic() < next_renewal:
        return
    next_renewal = time.monotonic() + RENEW_INTERVAL
    now = int(time.time() * 1000)
    try:
        if not await cred.check_refresh():
            renewal = {"status": "current", "at": now}
            return
        # SDK refresh includes the confirm step that invalidates the previous cookie, so persist at once.
        await cred.refresh()
        save_credential({**saved, "sessdata": cred.sessdata, "bili_jct": cred.bili_jct, "dedeuserid": cred.dedeuserid, "ac_time_value": cred.ac_time_value})
        renewal = {"status": "renewed", "at": now}
    except Exception:
        renewal = {"status": "failed", "at": now}


async def bili_check_credential() -> str:
    """Verify the authenticated self endpoint (a public profile is not a login check), renewing the cookie when due."""
    cred, saved = load_saved()
    if not cred:
        return json.dumps({"logged_in": False, "message": "未登录"})
    await renew(cred, saved)
    info = await user.get_self_info(cred)
    state = renewal if cred.has_ac_time_value() else {"status": "unsupported"}
    return json.dumps({"logged_in": True, "uid": str(info.get("mid", "")), "username": info.get("name", ""), "message": "已登录", **({"renewal": state} if state else {})}, ensure_ascii=False)


async def bili_search(keyword: str, num: int = 10, order: str = "totalrank", published_after: int = 0, published_before: int = 0) -> str:
    """Search one page; native day bounds are a superset of patrol's exact window."""
    orders = {"totalrank": search.OrderVideo.TOTALRANK, "click": search.OrderVideo.CLICK, "pubdate": search.OrderVideo.PUBDATE, "dm": search.OrderVideo.DM}
    size = max(1, min(num, 50))
    dates = {}
    if published_after and published_before:
        # The pinned SDK parses local YYYY-MM-DD midnights, with an exclusive end.
        dates = {"time_start": datetime.fromtimestamp(published_after).strftime("%Y-%m-%d"), "time_end": (datetime.fromtimestamp(published_before) + timedelta(days=1)).strftime("%Y-%m-%d")}
    data = await search.search_by_type(keyword=keyword, search_type=search.SearchObjectType.VIDEO, page=1, page_size=size, order_type=orders.get(order, search.OrderVideo.TOTALRANK), **dates)
    videos = []
    for item in data.get("result", [])[:size]:
        title = html.unescape(re.sub(r"<[^>]*>", "", item.get("title", "")))
        author = html.unescape(re.sub(r"<[^>]*>", "", item.get("author", "")))
        videos.append({"bvid": item.get("bvid", ""), "aid": item.get("aid", 0), "title": re.sub(r"\s+", " ", title).strip(), "author": re.sub(r"\s+", " ", author).strip(), "play": item.get("play", 0), "pubdate": item.get("pubdate", 0)})
    return json.dumps({"videos": videos}, ensure_ascii=False)


async def bili_comments(bvid: str, num: int = 30) -> str:
    """Only top-level ordinary comments; preserve pinned metadata and propagate errors."""
    cred = upstream.get_cred()
    info = await video.Video(bvid=bvid, credential=cred).get_info()
    response = await comment.get_comments(oid=info["aid"], type_=comment.CommentResourceType.VIDEO, page_index=1, order=comment.OrderType.LIKE, credential=cred)
    pinned_ids = set()
    for item in response.get("top_replies") or []:
        pinned_ids.add(item.get("rpid"))
    for item in (response.get("upper", {}).get("top"), response.get("top")):
        if isinstance(item, dict):
            pinned_ids.add(item.get("rpid"))
    comments = []
    for item in (response.get("replies") or [])[:max(1, min(num, 50))]:
        # Unknown pin metadata is unsafe. Bilibili returns reply_control for normal rows.
        control = item.get("reply_control")
        member = item.get("member") or {}
        pinned = item.get("rpid") in pinned_ids or bool((control or {}).get("is_up_top")) or bool(item.get("is_top"))
        comments.append({"rpid": item.get("rpid", 0), "user": member.get("uname", ""), "uid": str(member.get("mid", "")), "content": (item.get("content") or {}).get("message", ""), "pinned": pinned, "ordinary": isinstance(control, dict) and item.get("root", 0) == 0 and not pinned})
    return json.dumps({"comments": comments}, ensure_ascii=False)


def optional(read):
    try:
        return read()
    except Exception:
        return None


def post_receipt(info, result):
    """Display-only facts from responses the send path already holds; bad values only drop a field."""
    receipt = {
        "rpid": optional(lambda: int(result["rpid"])),
        "cover": optional(lambda: str(info["pic"])),
        "stat": optional(lambda: {key: int(info["stat"][key]) for key in ("view", "like", "reply", "favorite")}),
    }
    return {key: value for key, value in receipt.items() if value is not None}


async def bili_reply(bvid: str, text: str, rpid: int = 0, root: int = 0, operation_id: str = "") -> str:
    """
    在B站视频下发表评论或回复某条评论

    Args:
        bvid: 视频BV号
        text: 评论/回复的文本内容
        rpid: 要回复的目标评论ID（0表示发表新评论）
        root: 楼层根评论ID（回复一级评论时不用填，回复楼中楼时填根评论ID）

    Returns:
        发表结果；成功时附新评论 rpid、视频封面和发送时播放数据
    """
    if operation_id.startswith("lookup:"):
        lookup_id = operation_id.removeprefix("lookup:")
        try:
            uuid.UUID(lookup_id)
        except (ValueError, TypeError, AttributeError):
            return json.dumps({"error_type":"api", "stage":"prepare", "send_state":"confirmed_not_sent", "error_code":"invalid_operation_id"}, ensure_ascii=False)
        digest = hashlib.sha256(json.dumps([bvid, text, int(rpid), int(root)], ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
        path = upstream.CRED_FILE.with_name("interaction_operations.json")
        records = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        if not isinstance(records, dict):
            raise ValueError("operation journal format")
        record = records.get(lookup_id)
        if record is None:
            return json.dumps({"status":"not_found"}, ensure_ascii=False)
        if record.get("payload_hash") != digest:
            return json.dumps({"error_type":"api", "stage":"prepare", "send_state":"confirmed_not_sent", "error_code":"operation_id_conflict"}, ensure_ascii=False)
        state = record.get("state")
        if state == "succeeded":
            return json.dumps({"status":"succeeded", "result":record.get("result")}, ensure_ascii=False)
        if state == "confirmed_failure":
            return json.dumps({"status":"confirmed_failure", "result":record.get("result")}, ensure_ascii=False)
        if state == "uncertain":
            return json.dumps({"status":"uncertain", "result":record.get("result")}, ensure_ascii=False)
        if state == "started":
            task = active_operations.get(lookup_id)
            owner_pid = record.get("bridge_pid")
            owner_alive = False
            if isinstance(owner_pid, int) and owner_pid != os.getpid():
                try:
                    os.kill(owner_pid, 0)
                    owner_alive = True
                except ProcessLookupError:
                    owner_alive = False
                except (PermissionError, OSError):
                    # Unknown process state is treated as alive; never turn uncertainty into a retry.
                    owner_alive = True
            if task is not None and not task.done() or owner_alive:
                return json.dumps({"status":"running"}, ensure_ascii=False)
            return json.dumps({"status":"interrupted"}, ensure_ascii=False)
        return json.dumps({"status":"uncertain"}, ensure_ascii=False)
    if not operation_id:
        # Direct/manual MCP callers keep the original tool contract. The patrol scheduler
        # always supplies an operation id and uses the durable journal path below.
        try:
            cred = upstream.get_cred()
            info = await video.Video(bvid=bvid, credential=cred).get_info()
            if rpid == 0:
                sent = await comment.send_comment(text=text, oid=info["aid"], type_=comment.CommentResourceType.VIDEO, credential=cred)
            else:
                sent = await comment.send_comment(text=text, oid=info["aid"], type_=comment.CommentResourceType.VIDEO, root=root if root != 0 else rpid, parent=rpid, credential=cred)
            return json.dumps({"success":True,"message":"评论发送成功",**post_receipt(info,sent)}, ensure_ascii=False)
        except Exception as error:
            return json.dumps({"success":False,"error":str(error)}, ensure_ascii=False)
    try:
        uuid.UUID(operation_id)
    except (ValueError, TypeError, AttributeError):
        return json.dumps({"success": False, "error_type":"api", "stage":"prepare", "send_state":"confirmed_not_sent", "error_code":"invalid_operation_id"}, ensure_ascii=False)
    digest = hashlib.sha256(json.dumps([bvid, text, int(rpid), int(root)], ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    path = upstream.CRED_FILE.with_name("interaction_operations.json")

    def read_journal():
        if not path.exists():
            return {}
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError("operation journal format")
        return value

    def save_record(record):
        records = read_journal()
        records[operation_id] = {**record, "bridge_pid": os.getpid()}
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = path.with_suffix(".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(records, file, ensure_ascii=False, separators=(",", ":"))
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
        path.chmod(0o600)

    previous = read_journal().get(operation_id)
    if previous:
        if previous.get("payload_hash") != digest:
            return json.dumps({"success": False, "error_type":"api", "stage":"prepare", "send_state":"confirmed_not_sent", "error_code":"operation_id_conflict"}, ensure_ascii=False)
        if previous.get("state") == "succeeded":
            return json.dumps(previous.get("result") or {"success": True}, ensure_ascii=False)
        if previous.get("state") == "confirmed_failure":
            return json.dumps(previous.get("result") or {"success": False, "send_state":"confirmed_not_sent"}, ensure_ascii=False)
        # A journal entry left at started is intentionally never submitted again.
        return json.dumps({"success": False, "error_type":"api", "stage":"send", "send_state":"uncertain", "error_code":"operation_still_running" if operation_id in active_operations and not active_operations[operation_id].done() else "operation_interrupted"}, ensure_ascii=False)

    # Persist intent before invoking the platform. A crash can only produce an uncertain, non-replayed operation.
    save_record({"payload_hash": digest, "state":"started", "result":None})

    async def execute_once():
        try:
            cred = upstream.get_cred()
            info = await video.Video(bvid=bvid, credential=cred).get_info()
        except Exception as error:
            result = {"success":False, "error_type":error_kind(error), "stage":"prepare", "send_state":"confirmed_not_sent", "error_code":"prepare_failed"}
            save_record({"payload_hash":digest,"state":"confirmed_failure","result":result})
            return result
        try:
            if rpid == 0:
                sent = await comment.send_comment(text=text, oid=info["aid"], type_=comment.CommentResourceType.VIDEO, credential=cred)
            else:
                sent = await comment.send_comment(text=text, oid=info["aid"], type_=comment.CommentResourceType.VIDEO, root=root if root != 0 else rpid, parent=rpid, credential=cred)
        except Exception as error:
            # Unless the SDK returned a durable success payload, submission cannot be ruled out.
            result = {"success":False, "error_type":error_kind(error), "stage":"send", "send_state":"uncertain", "error_code":"send_result_unknown"}
            save_record({"payload_hash":digest,"state":"uncertain","result":result})
            return result
        result = {"success":True, "message":"评论发送成功", **post_receipt(info, sent)}
        save_record({"payload_hash":digest,"state":"succeeded","result":result})
        return result

    task = asyncio.create_task(execute_once())
    active_operations[operation_id] = task
    task.add_done_callback(lambda _task: active_operations.pop(operation_id, None))
    try:
        result = await asyncio.shield(task)
    except asyncio.CancelledError:
        # The shielded operation keeps running and persists its eventual receipt for an idempotent poll.
        result = {"success":False, "error_type":"api", "stage":"send", "send_state":"uncertain", "error_code":"client_disconnected"}
    return json.dumps(result, ensure_ascii=False)


async def qr_request(name, **params):
    """The SDK's own anonymous web QR request, keeping the Set-Cookie values its QR helper discards."""
    api = Api(credential=Credential(), **QR_API[name])
    if params:
        api.update_params(**params)
    response = await get_client().request(**await api._prepare_request())
    if response.code != 200:
        raise NetworkException(response.code, "")
    body = response.json()
    if body.get("code") != 0:
        raise Exception(f"QR API code {body.get('code')}")
    return body.get("data") or {}, response.cookies


def qr_cookies(url, cookies):
    """Raw cookie values from Set-Cookie headers, falling back to the cross-domain URL query."""
    found = {}
    for part in urlsplit(url or "").query.split("&"):
        key, separator, value = part.partition("=")
        if separator and value:
            found[key.lower()] = value
    found.update({key.lower(): value for key, value in (cookies or {}).items() if value})
    return found


def save_credential(values):
    path = upstream.CRED_FILE
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as file:
        json.dump(values, file)
    temporary.replace(path)
    path.chmod(0o600)


async def bili_login() -> str:
    """Generate the QR in memory; never write a QR or login URL into vendor, temp files or logs."""
    global qr_session
    data, _ = await qr_request("get_qrcode_and_token")
    image = io.BytesIO()
    qrcode.make(data["url"]).save(image)
    qr_session = data["qrcode_key"]
    encoded = base64.b64encode(image.getvalue()).decode("ascii")
    return json.dumps({"status": "qrcode_ready", "qrcode_image": f"data:image/png;base64,{encoded}", "message": "请用 Bilibili App 扫码并在手机上确认，状态会自动更新"}, ensure_ascii=False)


async def bili_login_check() -> str:
    """Poll the web QR key and replace credentials only when every login cookie is present."""
    global qr_session, next_renewal, renewal
    if qr_session is None:
        return await bili_check_credential()
    data, cookies = await qr_request("get_events", qrcode_key=qr_session)
    state = data.get("code")
    if state == 86101:
        return json.dumps({"status": "waiting_scan", "message": "等待扫码"}, ensure_ascii=False)
    if state == 86090:
        return json.dumps({"status": "waiting_confirm", "message": "已扫码，等待手机确认"}, ensure_ascii=False)
    if state == 86038:
        qr_session = None
        return json.dumps({"status": "timeout", "message": "二维码已过期，请重新生成"}, ensure_ascii=False)
    if state != 0:
        raise Exception(f"QR state {state}")
    # A confirmed key is single-use; an incomplete answer must never replace a working login.
    qr_session = None
    found = qr_cookies(data.get("url"), cookies)
    missing = [name for name in LOGIN_COOKIES if not found.get(name.lower())]
    if missing or not found["dedeuserid"].isdigit():
        seen = "、".join(sorted(found)) or "无"
        return json.dumps({"status": "incomplete", "message": f"B 站已确认扫码，但没有返回完整登录凭证（缺少 {'、'.join(missing) or 'DedeUserID'}；收到字段：{seen}）。原有登录未改动，请重试或改用 Cookie 登录。"}, ensure_ascii=False)
    # ac_time_value is the web refresh_token used by renew(); a new login is checked on the next login check.
    save_credential({"sessdata": found["sessdata"], "bili_jct": found["bili_jct"], "buvid3": found.get("buvid3", ""), "dedeuserid": found["dedeuserid"], "ac_time_value": data.get("refresh_token") or ""})
    next_renewal, renewal = 0.0, None
    return json.dumps({"status": "done", "message": "登录完成"}, ensure_ascii=False)


def guarded(name, function):
    @functools.wraps(function)
    async def invoke(*args, **kwargs):
        async with lock:
            try:
                lookup = name == "bili_reply" and str(kwargs.get("operation_id", "")).startswith("lookup:")
                if name in WRITES and not lookup and os.environ.get("BILIBILI_WRITES_ENABLED") != "true":
                    return json.dumps({"error_type": "disabled", "error": "真实写操作未启用", "stage":"prepare", "send_state":"confirmed_not_sent", "error_code":"writes_disabled"}, ensure_ascii=False)
                result = json.loads(await function(*args, **kwargs))
                if isinstance(result, dict) and ("error" in result or result.get("success") is False or "at_error" in result or "likes_error" in result):
                    send_state = result.get("send_state") if name in WRITES else "not_applicable"
                    kind=result.get("error_type") if result.get("error_type") in ("risk","auth","api","disabled") else error_kind(result)
                    stage=result.get("stage") if result.get("stage") in ("prepare","send","receipt","unknown") else ("send" if name in WRITES else "unknown")
                    code=result.get("error_code") if isinstance(result.get("error_code"),str) else "platform_error"
                    return json.dumps({"error_type": kind, "stage":stage, "send_state":send_state or "uncertain", "error_code":code}, ensure_ascii=False)
                return json.dumps(scrub(result), ensure_ascii=False)
            except Exception as error:
                # No exception text, arguments or credentials cross the MCP boundary.
                return json.dumps({"error_type": error_kind(error), "stage":"send" if name in WRITES else "unknown", "send_state":"uncertain" if name in WRITES else "not_applicable", "error_code":"bridge_exception"}, ensure_ascii=False)
    return invoke


OVERRIDES = {"bili_check_credential": bili_check_credential, "bili_search": bili_search, "bili_comments": bili_comments, "bili_reply": bili_reply, "bili_login": bili_login, "bili_login_check": bili_login_check}
for tool_name in TOOLS:
    function = OVERRIDES.get(tool_name, getattr(upstream, tool_name))
    upstream.mcp.remove_tool(tool_name)
    upstream.mcp.add_tool(guarded(tool_name, function), name=tool_name)

if __name__ == "__main__":
    upstream.mcp.run(transport="stdio")
