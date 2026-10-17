// fetch 封装：出错抛带状态码的错误
async function request(path) {
  let res;
  try {
    res = await fetch(path, { headers: { Accept: 'application/json' } });
  } catch (e) {
    const err = new Error('网络请求失败：' + path);
    err.status = 0;
    throw err;
  }
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
    } catch (_) { /* 非 JSON 响应，用默认消息 */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function getOverview() {
  return request('/api/overview');
}

function getRun(id) {
  return request('/api/runs/' + encodeURIComponent(id));
}

// 文件内容是纯文本
async function getFile(id, name) {
  const res = await fetch('/api/runs/' + encodeURIComponent(id) + '/file?name=' + encodeURIComponent(name));
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
    } catch (_) { /* 非 JSON 响应 */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

function getFeed(id, sub) {
  return request('/api/runs/' + encodeURIComponent(id) + '/subtasks/' + encodeURIComponent(sub) + '/feed');
}

function getBill(range) {
  const q = range && range !== '7d' ? '?range=' + encodeURIComponent(range) : '';
  return request('/api/bill' + q);
}

export { getOverview, getRun, getFile, getFeed, getBill };
