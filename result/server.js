var express = require('express'),
    async = require('async'),
    { Pool } = require('pg'),
    cookieParser = require('cookie-parser'),
    app = express(),
    server = require('http').Server(app),
    io = require('socket.io')(server);

// ============================================
// Configuration from environment variables
// ============================================
var port = process.env.RESULT_PORT || process.env.PORT || 80;

var pgConfig = {
  host: process.env.POSTGRES_HOST || 'db',
  port: parseInt(process.env.POSTGRES_PORT) || 5432,
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
  database: process.env.POSTGRES_DB || 'postgres',
};

console.log('Connecting to PostgreSQL at ' + pgConfig.host + ':' + pgConfig.port);

// ============================================
// Socket.IO
// ============================================
io.on('connection', function (socket) {
  socket.emit('message', { text: 'Welcome!' });

  socket.on('subscribe', function (data) {
    socket.join(data.channel);
  });
});

// ============================================
// PostgreSQL connection with retry
// ============================================
var pool = new Pool(pgConfig);

var connectedClient = null;

async.retry(
  { times: 1000, interval: 1000 },
  function (callback) {
    pool.connect(function (err, client, done) {
      if (err) {
        console.error('Waiting for db...');
      }
      callback(err, client);
    });
  },
  function (err, client) {
    if (err) {
      return console.error('Giving up connecting to db');
    }
    console.log('Connected to db');
    connectedClient = client;
    getVotes(client);
  }
);

// ============================================
// Query votes and emit via Socket.IO
// ============================================
function getVotes(client) {
  client.query(
    'SELECT vote, COUNT(id) AS count FROM votes GROUP BY vote',
    [],
    function (err, result) {
      if (err) {
        console.error('Error performing query: ' + err);
      } else {
        var votes = collectVotesFromResult(result);
        io.sockets.emit('scores', JSON.stringify(votes));
      }

      setTimeout(function () {
        getVotes(client);
      }, 1000);
    }
  );
}

function collectVotesFromResult(result) {
  var votes = { a: 0, b: 0 };

  result.rows.forEach(function (row) {
    votes[row.vote] = parseInt(row.count);
  });

  return votes;
}

// ============================================
// Express middleware & routes
// ============================================
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname + '/views'));

app.get('/', function (req, res) {
  res.sendFile(__dirname + '/views/index.html');
});

// ============================================
// Health check endpoint
// ============================================
app.get('/health', function (req, res) {
  // Check if we have an active DB connection
  pool.query('SELECT 1', function (err) {
    if (err) {
      console.error('Health check failed:', err.message);
      return res.status(503).json({
        status: 'error',
        postgres: 'disconnected',
        error: err.message,
      });
    }
    return res.status(200).json({
      status: 'ok',
      postgres: 'connected',
    });
  });
});

// ============================================
// Start server
// ============================================
server.listen(port, function () {
  var actualPort = server.address().port;
  console.log('Result app running on port ' + actualPort);
});
