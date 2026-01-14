FROM alpine
ADD linktool.tar.gz /app/
RUN echo init \
    && sed -i 's#https\?://dl-cdn.alpinelinux.org/alpine#https://mirrors.tuna.tsinghua.edu.cn/alpine#g' /etc/apk/repositories \
    && apk update \
    && apk add --no-cache python3 py3-pip nginx \
    && pip config set global.index-url https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple \
    && python3 -m venv /app/.venv \
    && /app/.venv/bin/pip install --no-cache-dir "fastapi[standard]" \
    && rm /etc/nginx/http.d/default.conf \
    && mkdir -p /var/www/html \
    && cp /app/nginx_conf/default.conf /etc/nginx/http.d/default.conf \
    && cp -r /app/html/* /var/www/html/ \
    && chown -R nginx:nginx /var/www/html
WORKDIR /app
EXPOSE 80
ENTRYPOINT [ "/bin/ash" ]
CMD [ "/app/scripts/init.sh" ]
