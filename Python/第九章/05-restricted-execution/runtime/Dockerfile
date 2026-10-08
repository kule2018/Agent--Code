FROM python:3.12-slim-bookworm
WORKDIR /opt/runner
COPY requirements.lock ./
RUN python -m pip install --no-cache-dir --require-hashes -r requirements.lock
COPY entry.py query_worker.py model.py ./
USER 1000:1000
ENTRYPOINT ["python", "-X", "utf8", "-B", "-u", "/opt/runner/entry.py"]
