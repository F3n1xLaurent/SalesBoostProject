import unittest
from unittest.mock import AsyncMock,patch
import httpx
from network import preflight_get


class PreflightNetworkTests(unittest.IsolatedAsyncioTestCase):
    async def test_transient_connect_timeout_retries_same_read_only_request_once(self):
        url='https://api.elevenlabs.io/v1/models'
        response=httpx.Response(200,json=[],request=httpx.Request('GET',url))
        client=AsyncMock();client.get.side_effect=[httpx.ConnectTimeout('private proxy',request=httpx.Request('GET',url)),response]
        with patch('asyncio.sleep',new=AsyncMock()):
            self.assertIs(await preflight_get(client,url,headers={'xi-api-key':'test'}),response)
        self.assertEqual(client.get.await_count,2)
        self.assertEqual(client.get.await_args_list[0],client.get.await_args_list[1])
        client.post.assert_not_awaited()

    async def test_persistent_connection_failure_is_bounded_and_preserves_original_error(self):
        error=httpx.ConnectError('private proxy',request=httpx.Request('GET','https://api.elevenlabs.io/v1/models'))
        client=AsyncMock();client.get.side_effect=error
        with patch('asyncio.sleep',new=AsyncMock()),self.assertRaises(httpx.ConnectError) as failure:
            await preflight_get(client,'https://api.elevenlabs.io/v1/models')
        self.assertIs(failure.exception,error)
        self.assertEqual(client.get.await_count,2)

    async def test_authentication_and_response_timeouts_are_not_replayed(self):
        url='https://api.elevenlabs.io/v1/models'
        client=AsyncMock();response=httpx.Response(401,request=httpx.Request('GET',url));client.get.return_value=response
        self.assertIs(await preflight_get(client,url),response)
        self.assertEqual(client.get.await_count,1)
        client.get.reset_mock();client.get.side_effect=httpx.ReadTimeout('timeout',request=httpx.Request('GET',url))
        with self.assertRaises(httpx.ReadTimeout):await preflight_get(client,url)
        self.assertEqual(client.get.await_count,1)
