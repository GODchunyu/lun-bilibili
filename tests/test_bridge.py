import importlib.util
import os
from datetime import datetime, timedelta
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from bilibili_api.exceptions import NetworkException

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("yui_bridge", ROOT / "bridge/server.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class BridgeBehavior(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Never let a test read or rotate the real private credential.
        directory = self.enterContext(tempfile.TemporaryDirectory(prefix="yui-bridge-"))
        self.enterContext(patch.object(bridge.upstream, "CRED_FILE", Path(directory) / "bili_credential.json"))
        bridge.next_renewal, bridge.renewal = 0.0, None

    def local_login(self):
        return patch.object(bridge, "load_saved", return_value=(bridge.Credential(sessdata="LOCAL", bili_jct="LOCAL", dedeuserid="100"), {}))

    async def qr_check(self, path, data, cookies=None):
        with patch.object(bridge.upstream, "CRED_FILE", path), patch.object(bridge, "qr_request", new=AsyncMock(return_value=(data, cookies or {}))) as request:
            bridge.qr_session = "LOCAL_QR_KEY"
            value = json.loads(await bridge.guarded("bili_login_check", bridge.bili_login_check)())
            request.assert_awaited_once_with("get_events", qrcode_key="LOCAL_QR_KEY")
            return value

    async def test_qr_completion_reads_set_cookie_and_keeps_refresh_token_privately(self):
        with tempfile.TemporaryDirectory(prefix="yui-qr-") as directory:
            path = Path(directory) / "bili_credential.json"
            bridge.next_renewal, bridge.renewal = 1e18, {"status": "unsupported"}
            # Synthetic values only; the URL carries no cookies, as observed from Bilibili.
            data = {"code": 0, "url": "https://passport.biligame.com/crossDomain?gourl=https%3A%2F%2Fwww.bilibili.com", "refresh_token": "LOCAL_REFRESH_TOKEN"}
            value = await self.qr_check(path, data, {"SESSDATA": "LOCAL_SESSDATA%2C1", "bili_jct": "LOCAL_JCT", "DedeUserID": "100", "sid": "LOCAL_SID"})
            self.assertEqual(value["status"], "done")
            self.assertIsNone(bridge.qr_session)
            self.assertEqual((bridge.next_renewal, bridge.renewal), (0.0, None))
            if os.name != "nt":
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text()), {"sessdata": "LOCAL_SESSDATA%2C1", "bili_jct": "LOCAL_JCT", "buvid3": "", "dedeuserid": "100", "ac_time_value": "LOCAL_REFRESH_TOKEN"})
            self.assertNotIn("LOCAL_", json.dumps(value))

    async def test_qr_completion_still_accepts_documented_cross_domain_url_cookies(self):
        with tempfile.TemporaryDirectory(prefix="yui-qr-") as directory:
            path = Path(directory) / "bili_credential.json"
            url = "https://passport.biligame.com/crossDomain?DedeUserID=100&DedeUserID__ckMd5=LOCAL&Expires=1&SESSDATA=LOCAL_SESSDATA%2C1&bili_jct=LOCAL_JCT&gourl=https%3A%2F%2Fpassport.bilibili.com"
            value = await self.qr_check(path, {"code": 0, "url": url, "refresh_token": ""})
            self.assertEqual(value["status"], "done")
            saved = json.loads(path.read_text())
            self.assertEqual((saved["sessdata"], saved["bili_jct"], saved["dedeuserid"]), ("LOCAL_SESSDATA%2C1", "LOCAL_JCT", "100"))

    async def test_qr_completion_without_cookies_never_replaces_working_login(self):
        with tempfile.TemporaryDirectory(prefix="yui-qr-") as directory:
            path = Path(directory) / "bili_credential.json"
            path.write_text('{"sessdata": "LOCAL_EXISTING"}')
            value = await self.qr_check(path, {"code": 0, "url": "https://passport.biligame.com/crossDomain?gourl=x", "refresh_token": "LOCAL_REFRESH_TOKEN"})
            self.assertEqual(value["status"], "incomplete")
            self.assertIn("SESSDATA、bili_jct、DedeUserID", value["message"])
            self.assertIn("gourl", value["message"])
            self.assertNotIn("LOCAL_", json.dumps(value))
            self.assertEqual(path.read_text(), '{"sessdata": "LOCAL_EXISTING"}')
            self.assertIsNone(bridge.qr_session)

    async def test_qr_pending_states_do_not_write_and_timeout_ends_the_session(self):
        with tempfile.TemporaryDirectory(prefix="yui-qr-") as directory:
            path = Path(directory) / "bili_credential.json"
            for code, status in ((86101, "waiting_scan"), (86090, "waiting_confirm")):
                self.assertEqual((await self.qr_check(path, {"code": code}))["status"], status)
                self.assertEqual(bridge.qr_session, "LOCAL_QR_KEY")
            self.assertEqual((await self.qr_check(path, {"code": 86038}))["status"], "timeout")
            self.assertIsNone(bridge.qr_session)
            self.assertFalse(path.exists())

    async def test_qr_request_keeps_sdk_request_and_classifies_http_rejection_as_risk(self):
        class Response:
            def __init__(self, code, body, cookies):
                self.code, self.body, self.cookies = code, body, cookies
            def json(self):
                return self.body
        class Client:
            def __init__(self, response):
                self.response, self.config = response, None
            async def request(self, **config):
                self.config = config
                return self.response
        prepared = {"method": "GET", "url": "https://passport.bilibili.com/x/passport-login/web/qrcode/poll", "params": {"qrcode_key": "LOCAL_QR_KEY"}, "data": {}, "files": {}, "cookies": {}, "headers": {}}
        client = Client(Response(200, {"code": 0, "data": {"code": 86101}}, {"SESSDATA": "LOCAL"}))
        with patch.object(bridge.Api, "_prepare_request", new=AsyncMock(return_value=prepared)), patch.object(bridge, "get_client", return_value=client):
            self.assertEqual(await bridge.qr_request("get_events", qrcode_key="LOCAL_QR_KEY"), ({"code": 86101}, {"SESSDATA": "LOCAL"}))
            self.assertEqual(client.config, prepared)
            client.response = Response(412, {}, {})
            bridge.qr_session = "LOCAL_QR_KEY"
            result = json.loads(await bridge.guarded("bili_login_check", bridge.bili_login_check)())
            self.assertEqual(result["error_type"], "risk")
            bridge.qr_session = None

    async def test_qr_generation_returns_png_in_memory_and_stores_only_the_key(self):
        with patch.object(bridge, "qr_request", new=AsyncMock(return_value=({"url": "https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=LOCAL", "qrcode_key": "LOCAL_QR_KEY"}, {}))):
            value = json.loads(await bridge.bili_login())
            self.assertTrue(value["qrcode_image"].startswith("data:image/png;base64,iVBOR"))
            self.assertEqual(bridge.qr_session, "LOCAL_QR_KEY")
            bridge.qr_session = None

    async def test_authenticated_self_endpoint_failure_is_not_public_profile_login_success(self):
        with self.local_login(), patch.object(bridge.user, "get_self_info", new=AsyncMock(side_effect=Exception("-101"))):
            check = bridge.guarded("bili_check_credential", bridge.bili_check_credential)
            result = json.loads(await check())
            self.assertEqual(result["error_type"], "auth")
            self.assertNotIn("logged_in", result)

    async def test_comment_api_risk_error_propagates_instead_of_silently_empty_comments(self):
        class FakeVideo:
            async def get_info(self):
                return {"aid": 1}
        with patch.object(bridge.upstream, "get_cred", return_value=object()), patch.object(bridge.video, "Video", return_value=FakeVideo()), patch.object(bridge.comment, "get_comments", new=AsyncMock(side_effect=Exception("-412"))):
            read = bridge.guarded("bili_comments", bridge.bili_comments)
            result = json.loads(await read("BV1000000001"))
            self.assertEqual(result["error_type"], "risk")
            self.assertNotIn("comments", result)

    async def test_http_rejections_propagate_risk_for_typed_and_upstream_string_errors(self):
        for status, kind in ((403, "risk"), (412, "risk"), (500, "api")):
            with self.subTest(status=status, path="typed"):
                with self.local_login(), patch.object(bridge.user, "get_self_info", new=AsyncMock(side_effect=NetworkException(status, "LOCAL_HTTP_FAILURE_BODY"))):
                    result = json.loads(await bridge.guarded("bili_check_credential", bridge.bili_check_credential)())
                    self.assertEqual(result["error_type"], kind)
                    self.assertNotIn("LOCAL_HTTP_FAILURE_BODY", json.dumps(result))
            with self.subTest(status=status, path="upstream_string"):
                with patch.object(bridge.upstream, "get_cred", return_value=object()), patch.object(bridge.upstream.session, "get_unread_messages", new=AsyncMock(side_effect=NetworkException(status, "LOCAL_HTTP_FAILURE_BODY"))):
                    result = json.loads(await bridge.guarded("bili_unread_messages", bridge.upstream.bili_unread_messages)())
                    self.assertEqual(result["error_type"], kind)
                    self.assertNotIn("LOCAL_HTTP_FAILURE_BODY", json.dumps(result))

    async def test_reply_keeps_upstream_send_arguments_and_returns_display_receipt(self):
        class FakeVideo:
            async def get_info(self):
                return {"aid": 1, "pic": "http://i0.hdslb.com/bfs/archive/cover.jpg", "stat": {"view": 12345, "like": 6, "reply": 7, "favorite": 8, "coin": 9}}
        send = AsyncMock(return_value={"rpid": 290501715345, "rpid_str": "290501715345"})
        cred = object()
        with patch.dict(bridge.os.environ, {"BILIBILI_WRITES_ENABLED": "true"}), patch.object(bridge.upstream, "get_cred", return_value=cred), patch.object(bridge.video, "Video", return_value=FakeVideo()), patch.object(bridge.comment, "send_comment", new=send):
            reply = bridge.guarded("bili_reply", bridge.OVERRIDES["bili_reply"])
            result = json.loads(await reply("BV1000000001", "好耶", 0, 0))
            self.assertEqual(result, {"success": True, "message": "评论发送成功", "rpid": 290501715345, "cover": "http://i0.hdslb.com/bfs/archive/cover.jpg", "stat": {"view": 12345, "like": 6, "reply": 7, "favorite": 8}})
            send.assert_awaited_once_with(text="好耶", oid=1, type_=bridge.comment.CommentResourceType.VIDEO, credential=cred)
            send.reset_mock()
            await reply("BV1000000001", "好耶", 4, 4)
            send.assert_awaited_once_with(text="好耶", oid=1, type_=bridge.comment.CommentResourceType.VIDEO, root=4, parent=4, credential=cred)

    async def test_reply_metadata_gaps_never_turn_a_sent_comment_into_a_failure(self):
        class FakeVideo:
            async def get_info(self):
                return {"aid": 1, "stat": {"view": "unknown"}}
        with patch.dict(bridge.os.environ, {"BILIBILI_WRITES_ENABLED": "true"}), patch.object(bridge.upstream, "get_cred", return_value=object()), patch.object(bridge.video, "Video", return_value=FakeVideo()), patch.object(bridge.comment, "send_comment", new=AsyncMock(return_value=None)):
            result = json.loads(await bridge.guarded("bili_reply", bridge.bili_reply)("BV1000000001", "好耶"))
            self.assertEqual(result, {"success": True, "message": "评论发送成功"})

    async def test_reply_override_still_honours_write_lock_and_send_failures(self):
        send = AsyncMock(side_effect=Exception("-412"))
        with patch.object(bridge.upstream, "get_cred", return_value=object()), patch.object(bridge.comment, "send_comment", new=send):
            with patch.dict(bridge.os.environ, {"BILIBILI_WRITES_ENABLED": "false"}):
                result = json.loads(await bridge.guarded("bili_reply", bridge.bili_reply)("BV1000000001", "好耶"))
                self.assertEqual(result["error_type"], "disabled")
                send.assert_not_awaited()
            class FakeVideo:
                async def get_info(self):
                    return {"aid": 1}
            with patch.dict(bridge.os.environ, {"BILIBILI_WRITES_ENABLED": "true"}), patch.object(bridge.video, "Video", return_value=FakeVideo()):
                result = json.loads(await bridge.guarded("bili_reply", bridge.bili_reply)("BV1000000001", "好耶"))
                self.assertEqual(result["error_type"], "risk")
                self.assertNotIn("rpid", result)

    def save_local_login(self, token="LOCAL_OLD_TOKEN"):
        saved = {"sessdata": "LOCAL_OLD_SESSDATA", "bili_jct": "LOCAL_OLD_JCT", "buvid3": "LOCAL_BUVID", "dedeuserid": "100", "ac_time_value": token}
        bridge.upstream.CRED_FILE.write_text(json.dumps(saved))
        return saved

    async def login_check(self, check_refresh, refresh=None):
        info = AsyncMock(return_value={"mid": 100, "name": "LOCAL_NAME"})
        with patch.object(bridge.Credential, "check_refresh", new=check_refresh), patch.object(bridge.Credential, "refresh", new=refresh or AsyncMock()), patch.object(bridge.user, "get_self_info", new=info):
            result = json.loads(await bridge.guarded("bili_check_credential", bridge.bili_check_credential)())
        return result, info

    async def test_login_check_renews_cookie_when_bilibili_asks_and_persists_before_use(self):
        self.save_local_login()
        async def refresh(cred):
            cred.sessdata, cred.bili_jct, cred.ac_time_value = "LOCAL_NEW_SESSDATA", "LOCAL_NEW_JCT", "LOCAL_NEW_TOKEN"
        result, info = await self.login_check(AsyncMock(return_value=True), refresh)
        self.assertEqual(json.loads(bridge.upstream.CRED_FILE.read_text()), {"sessdata": "LOCAL_NEW_SESSDATA", "bili_jct": "LOCAL_NEW_JCT", "buvid3": "LOCAL_BUVID", "dedeuserid": "100", "ac_time_value": "LOCAL_NEW_TOKEN"})
        if os.name != "nt":
            self.assertEqual(bridge.upstream.CRED_FILE.stat().st_mode & 0o777, 0o600)
        self.assertEqual(info.await_args.args[0].sessdata, "LOCAL_NEW_SESSDATA")
        self.assertTrue(result["logged_in"])
        self.assertEqual(result["renewal"]["status"], "renewed")
        self.assertNotIn("LOCAL_NEW", json.dumps(result))
        self.assertNotIn("LOCAL_OLD", json.dumps(result))

    async def test_login_check_asks_about_renewal_at_most_once_per_interval(self):
        saved = self.save_local_login()
        check = AsyncMock(return_value=False)
        first, _ = await self.login_check(check)
        second, _ = await self.login_check(check)
        self.assertEqual(check.await_count, 1)
        self.assertEqual((first["renewal"]["status"], second["renewal"]), ("current", first["renewal"]))
        self.assertEqual(json.loads(bridge.upstream.CRED_FILE.read_text()), saved)

    async def test_login_without_refresh_token_reports_unsupported_without_asking(self):
        self.save_local_login(token="")
        check = AsyncMock(return_value=True)
        result, _ = await self.login_check(check)
        check.assert_not_awaited()
        self.assertEqual(result["renewal"], {"status": "unsupported"})

    async def test_failed_renewal_keeps_current_cookie_and_login_check_still_succeeds(self):
        saved = self.save_local_login()
        result, info = await self.login_check(AsyncMock(return_value=True), AsyncMock(side_effect=NetworkException(412, "LOCAL_BODY")))
        self.assertEqual(json.loads(bridge.upstream.CRED_FILE.read_text()), saved)
        self.assertEqual(info.await_args.args[0].sessdata, "LOCAL_OLD_SESSDATA")
        self.assertTrue(result["logged_in"])
        self.assertEqual(result["renewal"]["status"], "failed")
        self.assertNotIn("LOCAL_BODY", json.dumps(result))

    async def test_native_search_days_cover_short_and_multi_day_windows_before_ranking(self):
        # Exercise the real pinned SDK date conversion, replacing only network I/O.
        for hours in (1, 72):
            with self.subTest(hours=hours):
                end = datetime(2026, 10, 7, 1, 40)
                begin = end - timedelta(hours=hours)
                rows = [
                    {"bvid": "old", "play": 1000000, "pubdate": int((begin - timedelta(days=2)).timestamp())},
                    {"bvid": "begin", "play": 1000, "pubdate": int(begin.timestamp())},
                    {"bvid": "end", "play": 2000, "pubdate": int(end.timestamp())},
                    {"bvid": "edge", "play": 1500, "pubdate": int((end + timedelta(hours=1)).timestamp())},
                    {"bvid": "future", "play": 3000000, "pubdate": int((end + timedelta(days=2)).timestamp())},
                ]
                class LocalSearchApi:
                    def __init__(self, **_kwargs):
                        pass
                    def update_params(self, **params):
                        self.params = params
                        return self
                    @property
                    def result(self):
                        async def respond():
                            p = self.params
                            selected = [r for r in rows if p.get("pubtime_begin_s", 0) <= r["pubdate"] < p.get("pubtime_end_s", float("inf"))]
                            if p["order"] == "click":
                                selected.sort(key=lambda r: r["play"], reverse=True)
                            return {"result": selected[:p["page_size"]]}
                        return respond()
                with patch.object(bridge.search, "Api", LocalSearchApi):
                    result = json.loads(await bridge.bili_search("我的世界", num=3, order="click", published_after=int(begin.timestamp()), published_before=int(end.timestamp())))
                # Day padding preserves both exact endpoints, including same-day windows.
                # The extra edge result is deliberately left to Node's exact time check.
                self.assertEqual([r["bvid"] for r in result["videos"]], ["end", "edge", "begin"])

if __name__ == "__main__":
    unittest.main()
