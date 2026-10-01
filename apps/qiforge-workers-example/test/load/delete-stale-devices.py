# Retire every device of the oracle bot except the harness token's device and the
# gateway's current one. Env: MATRIX_ORACLE_ADMIN_ACCESS_TOKEN (any device token of
# the bot), MATRIX_ORACLE_ADMIN_PASSWORD, optional MATRIX_BASE_URL / ORACLE_URL.
import json,os,urllib.request,urllib.error
tok=os.environ['MATRIX_ORACLE_ADMIN_ACCESS_TOKEN']; pw=os.environ['MATRIX_ORACLE_ADMIN_PASSWORD']; base=os.environ.get('MATRIX_BASE_URL','https://mx.mike-test.ixo.world'); oracle=os.environ.get('ORACLE_URL','https://mike-devnet-oracle.ixo-api.workers.dev')
def req(method,path,body=None):
    r=urllib.request.Request(base+path, data=json.dumps(body).encode() if body is not None else None, method=method, headers={'Authorization':f'Bearer {tok}','Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(r, timeout=30) as resp: return resp.status, json.loads(resp.read() or b'{}')
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
_,me=req('GET','/_matrix/client/v3/account/whoami'); token_dev=me['device_id']; local=me['user_id'][1:].split(':')[0]
st=json.load(urllib.request.urlopen(urllib.request.Request(f'{oracle}/matrix/status', headers={'User-Agent':'curl/8.0'}), timeout=30)); cur=st.get('deviceId')
_,d=req('GET','/_matrix/client/v3/devices'); devs=[x['device_id'] for x in d['devices']]
doomed=[x for x in devs if x not in {token_dev, cur}]
print('token', token_dev, 'current gateway', cur, 'devices', len(devs), 'deleting', len(doomed))
code,res=req('POST','/_matrix/client/v3/delete_devices',{'devices':doomed})
if code==401:
    code,res=req('POST','/_matrix/client/v3/delete_devices',{'devices':doomed,'auth':{'type':'m.login.password','identifier':{'type':'m.id.user','user':local},'password':pw,'session':res.get('session')}})
print('delete status', code, '' if code==200 else res)
_,d=req('GET','/_matrix/client/v3/devices'); print('devices now', len(d['devices']))
