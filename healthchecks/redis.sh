#!/bin/sh
set -eo pipefail

redis-cli ping | grep -q PONG || exit 1
