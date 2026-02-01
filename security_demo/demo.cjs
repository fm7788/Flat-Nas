const express = require('express');
const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ==========================================
// 1. SQL Injection 模拟
// ==========================================
// 脆弱实现
app.get('/vuln/sql', (req, res) => {
    const username = req.query.username;
    // 危险：直接字符串拼接
    const query = `SELECT * FROM users WHERE username = '${username}'`;
    res.json({ 
        status: 'vulnerable', 
        executed_query: query,
        description: '直接拼接字符串，导致 SQL 逻辑被改变' 
    });
});

// 安全实现
app.get('/secure/sql', (req, res) => {
    const username = req.query.username;
    // 安全：模拟参数化查询
    const query = `SELECT * FROM users WHERE username = ?`;
    const params = [username];
    res.json({ 
        status: 'secure', 
        executed_query: query, 
        parameters: params,
        description: '使用参数化查询，输入被视为数据而非代码' 
    });
});

// ==========================================
// 2. XSS (Cross-Site Scripting) 模拟
// ==========================================
// 脆弱实现
app.get('/vuln/xss', (req, res) => {
    const input = req.query.input;
    // 危险：直接返回 HTML，未转义
    res.send(`<html><body><h1>Search Result: ${input}</h1></body></html>`);
});

// 安全实现
app.get('/secure/xss', (req, res) => {
    const input = req.query.input || '';
    // 安全：进行 HTML 实体编码
    const safeInput = input.replace(/&/g, '&amp;')
                           .replace(/</g, '&lt;')
                           .replace(/>/g, '&gt;')
                           .replace(/"/g, '&quot;')
                           .replace(/'/g, '&#039;');
    res.send(`<html><body><h1>Search Result: ${safeInput}</h1></body></html>`);
});

// ==========================================
// 3. Path Traversal (路径穿越) 模拟
// ==========================================
// 脆弱实现
app.get('/vuln/path', (req, res) => {
    const filename = req.query.filename;
    // 危险：直接拼接路径，未检查 ..
    const filePath = path.join(__dirname, 'files', filename);
    
    // 模拟读取（仅演示路径解析结果，不真实读取以防报错）
    res.json({ 
        status: 'vulnerable', 
        resolved_path: filePath,
        description: '未过滤 ../，可以访问上级目录' 
    });
});

// 安全实现
app.get('/secure/path', (req, res) => {
    const filename = req.query.filename;
    const baseDir = path.join(__dirname, 'files');
    const filePath = path.join(baseDir, filename);

    // 安全：检查解析后的路径是否仍在 baseDir 内
    if (!filePath.startsWith(baseDir)) {
        return res.status(403).json({ error: 'Access Denied: Invalid path' });
    }

    res.json({ 
        status: 'secure', 
        resolved_path: filePath,
        description: '路径被限制在允许的目录内' 
    });
});

// ==========================================
// 4. Code/Command Injection 模拟
// ==========================================
// 脆弱实现 (Command Injection)
app.get('/vuln/cmd', (req, res) => {
    const target = req.query.target;
    // 危险：直接拼接到 shell 命令
    // 注意：这里仅打印命令，不实际执行以保证安全，但在真实场景中这就是漏洞
    const cmd = `ping -c 1 ${target}`; 
    res.json({ 
        status: 'vulnerable', 
        command_to_execute: cmd,
        description: '输入包含 shell 元字符，导致执行额外命令'
    });
});

// 脆弱实现 (Code Injection - Eval)
app.get('/vuln/eval', (req, res) => {
    const script = req.query.script;
    try {
        // 危险：使用 eval 执行任意代码
        const result = eval(script);
        res.json({ result: result });
    } catch (e) {
        res.json({ error: e.message });
    }
});

// 安全实现
app.get('/secure/cmd', (req, res) => {
    const target = req.query.target;
    // 安全：验证输入格式 (例如仅允许 IP 地址)
    if (!/^[0-9.]+$/.test(target)) {
        return res.status(400).json({ error: 'Invalid IP format' });
    }
    const cmd = `ping -c 1 ${target}`;
    res.json({ 
        status: 'secure', 
        command_to_execute: cmd,
        description: '输入经过严格校验' 
    });
});

// ==========================================
// 5. XXE (XML External Entity) 模拟
// ==========================================
// 由于没有 XML 解析库，这里模拟解析逻辑
app.post('/vuln/xxe', (req, res) => {
    const xml = req.body.xml;
    // 模拟：如果 XML 包含 DOCTYPE 定义了外部实体
    if (xml && xml.includes('<!DOCTYPE') && xml.includes('SYSTEM')) {
        res.json({
            status: 'vulnerable',
            parsed_result: 'SECRET_FILE_CONTENT', // 模拟读取到了敏感文件
            description: '解析器未禁用外部实体，导致本地文件泄露'
        });
    } else {
        res.json({ status: 'normal', result: 'parsed xml' });
    }
});

// 启动服务器并运行测试
const server = app.listen(0, () => {
    const port = server.address().port;
    const baseUrl = `http://localhost:${port}`;
    console.log(`[Server] Running on port ${port}\n`);

    runTests(baseUrl);
});

async function runTests(baseUrl) {
    const fetch = global.fetch || require('node-fetch'); // 适配不同 node 版本

    console.log('--- 开始漏洞模拟测试 ---\n');

    // 1. SQL Injection Test
    console.log('[1. SQL Injection]');
    const sqlPayload = "admin' OR '1'='1";
    console.log(`Payload: ${sqlPayload}`);
    
    let res = await fetch(`${baseUrl}/vuln/sql?username=${encodeURIComponent(sqlPayload)}`);
    let data = await res.json();
    console.log(`[Vuln] 生成的 SQL: ${data.executed_query}`);
    
    res = await fetch(`${baseUrl}/secure/sql?username=${encodeURIComponent(sqlPayload)}`);
    data = await res.json();
    console.log(`[Safe] 生成的 SQL: ${data.executed_query} (参数: ${JSON.stringify(data.parameters)})`);
    console.log('');

    // 2. XSS Test
    console.log('[2. XSS]');
    const xssPayload = "<script>alert('xss')</script>";
    console.log(`Payload: ${xssPayload}`);

    res = await fetch(`${baseUrl}/vuln/xss?input=${encodeURIComponent(xssPayload)}`);
    let text = await res.text();
    console.log(`[Vuln] 响应内容: ${text.trim()}`);

    res = await fetch(`${baseUrl}/secure/xss?input=${encodeURIComponent(xssPayload)}`);
    text = await res.text();
    console.log(`[Safe] 响应内容: ${text.trim()}`);
    console.log('');

    // 3. Path Traversal Test
    console.log('[3. Path Traversal]');
    const pathPayload = "../../secret.txt";
    console.log(`Payload: ${pathPayload}`);

    res = await fetch(`${baseUrl}/vuln/path?filename=${encodeURIComponent(pathPayload)}`);
    data = await res.json();
    console.log(`[Vuln] 解析路径: ${data.resolved_path}`);

    res = await fetch(`${baseUrl}/secure/path?filename=${encodeURIComponent(pathPayload)}`);
    if (res.status === 403) {
        data = await res.json();
        console.log(`[Safe] 响应: ${res.status} ${data.error}`);
    }
    console.log('');

    // 4. Code/Command Injection Test
    console.log('[4. Code/Command Injection]');
    const cmdPayload = "127.0.0.1 && cat /etc/passwd";
    console.log(`Payload: ${cmdPayload}`);

    res = await fetch(`${baseUrl}/vuln/cmd?target=${encodeURIComponent(cmdPayload)}`);
    data = await res.json();
    console.log(`[Vuln] 拟执行命令: ${data.command_to_execute}`);

    res = await fetch(`${baseUrl}/secure/cmd?target=${encodeURIComponent(cmdPayload)}`);
    if (res.status === 400) {
        data = await res.json();
        console.log(`[Safe] 响应: ${res.status} ${data.error}`);
    }
    
    const evalPayload = "2 + 2";
    res = await fetch(`${baseUrl}/vuln/eval?script=${encodeURIComponent(evalPayload)}`);
    data = await res.json();
    console.log(`[Vuln] Eval Result ('2+2'): ${data.result}`);
    console.log('');

    // 5. XXE Test
    console.log('[5. XXE]');
    const xxePayload = `<?xml version="1.0"?><!DOCTYPE root [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><root>&xxe;</root>`;
    console.log(`Payload (Simulated): <!DOCTYPE root [<!ENTITY xxe SYSTEM "file:///etc/passwd">]...>`);
    
    res = await fetch(`${baseUrl}/vuln/xxe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ xml: xxePayload })
    });
    data = await res.json();
    console.log(`[Vuln] 解析结果: ${data.parsed_result}`);
    console.log('');

    console.log('--- 测试结束，正在关闭服务器 ---');
    process.exit(0);
}
