# STORY-010: Redis 7.4 (Streams, XAUTOCLAIM and lag all need 7+) with the
# settings Relay depends on, applied by start-redis.sh.
FROM redis:7.4-alpine
COPY start-redis.sh /usr/local/bin/start-redis.sh
RUN chmod +x /usr/local/bin/start-redis.sh
CMD ["start-redis.sh"]
