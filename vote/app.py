from flask import Flask, render_template, request, make_response, g, jsonify
from redis import Redis
import os
import socket
import random
import json
import logging

# ============================================
# Configuration from environment variables
# ============================================
REDIS_HOST = os.getenv('REDIS_HOST', 'redis')
REDIS_PORT = int(os.getenv('REDIS_PORT', 6379))
OPTION_A = os.getenv('OPTION_A', 'Cats')
OPTION_B = os.getenv('OPTION_B', 'Dogs')
VOTE_PORT = int(os.getenv('VOTE_PORT', 80))

hostname = socket.gethostname()

app = Flask(__name__)

gunicorn_error_logger = logging.getLogger('gunicorn.error')
app.logger.handlers.extend(gunicorn_error_logger.handlers)
app.logger.setLevel(logging.INFO)


def get_redis():
    """Get or create Redis connection (per-request)."""
    if not hasattr(g, 'redis'):
        g.redis = Redis(
            host=REDIS_HOST,
            port=REDIS_PORT,
            db=0,
            socket_timeout=5
        )
    return g.redis


@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint for K8s liveness/readiness probes."""
    try:
        redis = get_redis()
        redis.ping()
        return jsonify({
            'status': 'ok',
            'redis': 'connected',
            'hostname': hostname
        }), 200
    except Exception as e:
        app.logger.error('Health check failed: %s', str(e))
        return jsonify({
            'status': 'error',
            'redis': 'disconnected',
            'error': str(e)
        }), 503


@app.route('/', methods=['POST', 'GET'])
def hello():
    voter_id = request.cookies.get('voter_id')
    if not voter_id:
        voter_id = hex(random.getrandbits(64))[2:-1]

    vote = None

    if request.method == 'POST':
        redis = get_redis()
        vote = request.form['vote']
        app.logger.info('Received vote for %s', vote)
        data = json.dumps({'voter_id': voter_id, 'vote': vote})
        redis.rpush('votes', data)

    resp = make_response(render_template(
        'index.html',
        option_a=OPTION_A,
        option_b=OPTION_B,
        hostname=hostname,
        vote=vote,
    ))
    resp.set_cookie('voter_id', voter_id)
    return resp


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=VOTE_PORT, debug=True, threaded=True)
