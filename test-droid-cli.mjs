#!/usr/bin/env node
import { config } from 'dotenv';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

// Load .env file
config();

// Note: When using stream-jsonrpc for BOTH input and output, 
// the command line arguments are ignored/treated as specific args depending on implementation,
// but usually we just start the process and communicate via stdin.
const proc = spawn('droid', [
  'exec',
  '--input-format', 'stream-jsonrpc',
  '--output-format', 'stream-jsonrpc',
  '--cwd', process.cwd()
], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env
});

const rl = createInterface({ input: proc.stdout });

let messageCount = 0;
let sessionId = null;

// Print everything from stdout
rl.on('line', (line) => {
  messageCount++;
  console.log(`[STDOUT][${messageCount}] ${line}`);
  
  try {
    const msg = JSON.parse(line);
    
    // 1. Capture Session ID
    if (msg.type === 'response' && msg.result?.sessionId && !sessionId) {
      sessionId = msg.result.sessionId;
      console.log(`\n=== Session created (${sessionId}), sending 'hi' ===`);
      
      // 2. Send Message after session init
      setTimeout(() => {
        send('droid.add_user_message', {
          sessionId,
          text: 'hi' // Simulating a simple greeting
        });
      }, 500);
    }
    
    // Detect idle state
    if (msg.params?.notification?.type === 'droid_working_state_changed' && 
        msg.params?.notification?.newState === 'idle') {
      console.log('\n=== Droid idle detected ===');
      // Don't exit immediately, give it a moment to see if other messages arrive out of order
      setTimeout(() => {
        console.log('Exiting...');
        proc.stdin.end();
        proc.kill();
      }, 5000); 
    }
  } catch (e) {
    // console.error('Parse error:', e);
  }
});

proc.on('exit', (code) => {
  console.log(`\nProcess exited with code ${code}`);
  process.exit(code || 0);
});

function send(method, params) {
  const msg = {
    jsonrpc: "2.0",
    factoryApiVersion: "1.0.0",
    type: "request",
    method,
    params,
    id: randomUUID(),
  };
  const str = JSON.stringify(msg);
  console.log(`\n>>> Sent: ${method} (${str})`);
  proc.stdin.write(str + '\n');
}

console.log('=== Starting Droid Test ===');

// 0. Initialize Session
setTimeout(() => {
  console.log('Sending initialize_session...');
  send('droid.initialize_session', { 
    machineId: randomUUID(), 
    cwd: process.cwd(),
    // Important: Some Droid versions necessitate capabilities or explicit settings
  });
}, 1000);

// Watchdog
setTimeout(() => {
  console.log('TIMEOUT - Force killing');
  proc.kill();
}, 30000);
