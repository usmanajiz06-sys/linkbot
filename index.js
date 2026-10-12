
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const qrcode = require('qrcode-terminal');

// Sirf in do groups mein bot kaam karega
const TARGET_GROUPS = [
  '120363411919436005@g.us',
  '120363155554501334@g.us'
];

const BOT_NOTICE = 'Deleted By Math helper';
const warnedMessages = new Set();

function getMessageText(message) {
  if (!message) return '';

  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    ''
  );
}

// Common URLs aur domains ko identify karein
function containsLink(text) {
  return /(?:https?:\/\/|www\.)[^\s]+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|edu|gov|pk|io|co|app|info|me|tv|ly|gg|site|online|store|xyz)(?:\/[^\s]*)?/i.test(text);
}

// Video message ya video file ko identify karein
function containsVideo(message) {
  return Boolean(
    message?.videoMessage ||
    message?.documentMessage?.mimetype?.startsWith('video/')
  );
}

// Common Status-share message formats ko check karein
function containsStatusShare(message) {
  if (!message || typeof message !== 'object') return false;

  const statusKeys = [
    'statusMentionMessage',
    'groupStatusMessage',
    'groupStatusMessageV2',
    'statusV3Message'
  ];

  for (const key of Object.keys(message)) {
    if (statusKeys.includes(key)) return true;

    if (
      message[key] &&
      typeof message[key] === 'object' &&
      containsStatusShare(message[key])
    ) {
      return true;
    }
  }

  return false;
}

// Sender admin hai ya nahi
async function isGroupAdmin(sock, groupJid, senderJid) {
  if (!senderJid) return null;

  try {
    const metadata = await sock.groupMetadata(groupJid);

    const participant = metadata.participants.find(
      p =>
        p.id === senderJid ||
        p.phoneNumber === senderJid ||
        p.lid === senderJid
    );

    // Agar sender ki identity confirm na ho,
    // to safety ke liye deletion na karein
    if (!participant) return null;

    return (
      participant.admin === 'admin' ||
      participant.admin === 'superadmin'
    );
  } catch (err) {
    console.log('Admin check failed:', err.message);
    return null;
  }
}

let reconnecting = false;

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState('auth_info');

  const { version, isLatest } =
    await fetchLatestWaWebVersion();

  console.log('WhatsApp Web version:', version);
  console.log('Is latest version:', isLatest);

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async update => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      console.log('WhatsApp QR code scan karein:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('WhatsApp connected successfully!');
      console.log('Target groups:', TARGET_GROUPS);
      reconnecting = false;
    }

    if (connection === 'close') {
      const status =
        lastDisconnect?.error?.output?.statusCode;

      console.log('Connection closed. Status:', status);

      if (status === DisconnectReason.loggedOut) {
        console.log(
          'Session logout ho gaya. Dobara QR scan karna hoga.'
        );
        return;
      }

      if (!reconnecting) {
        reconnecting = true;

        console.log('2 seconds baad reconnect ki koshish hogi...');

        setTimeout(() => {
          startBot().catch(err => {
            console.log('Reconnect failed:', err.message);
            reconnecting = false;
          });
        }, 2000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;

        const groupJid = msg.key.remoteJid;

        // Sirf selected groups
        if (!TARGET_GROUPS.includes(groupJid)) continue;

        // Group sender ki identity check karein
        const senderJid = msg.key.participant;
        const adminStatus = await isGroupAdmin(
          sock,
          groupJid,
          senderJid
        );

        // Admin ko kabhi target na karein.
        // Unknown sender ho to bhi delete na karein.
        if (adminStatus !== false) {
          console.log('Admin/unknown sender ignored:', senderJid);
          continue;
        }

        const message = msg.message;
        const text = getMessageText(message);

        const hasLink = containsLink(text);
        const hasVideo = containsVideo(message);
        const hasStatus = containsStatusShare(message);

        // Link, video ya supported Status-share format
        if (!hasLink && !hasVideo && !hasStatus) continue;

        const messageId = msg.key.id;

        if (!messageId || warnedMessages.has(messageId)) continue;

        warnedMessages.add(messageId);

        // Pehle warning bhejein
        await sock.sendMessage(groupJid, {
          text:
            '⚠️ Warning: Is group mein links, videos ya Status share karna mana hai. Message delete karne ki koshish ki ja rahi hai.'
        });

        await new Promise(resolve => setTimeout(resolve, 1500));

        // Original member message delete karne ki request
        try {
          await sock.sendMessage(groupJid, {
            delete: msg.key
          });

          console.log('Deletion requested:', messageId);

          // Alag notice; WhatsApp ka asli deletion notice nahi
          await sock.sendMessage(groupJid, {
            text: BOT_NOTICE
          });
        } catch (deleteError) {
          console.log(
            'Deletion failed:',
            deleteError.message
          );
        }
      } catch (err) {
        console.log('Message handling error:', err.message);
      }
    }
  });
}

startBot().catch(err => {
  console.log('Bot startup error:', err);
});
