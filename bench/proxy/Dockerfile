# The proxy, as the artefact that actually runs.
#
# On a platform host the local runtime and the deployed one are different
# things, and steps 5 and 6 of the agent-model-proxy skill test each in turn.
# Here they are the same image, so `docker compose up` is the deployment.
#
# No credential is baked in: an ARG or ENV holding a key persists in the image
# and `docker history` prints it. Keys arrive at runtime through env_file or a
# mounted secret.
FROM node:22-alpine

# wget is already in the base image and is what the healthcheck uses, so no
# extra layer is needed for it.
WORKDIR /app

# Dependencies first, so editing the server does not reinstall them.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.mjs registry.mjs limit.mjs transcript.mjs types.mjs remote.mjs ./
COPY adapters ./adapters

# Written to by the transcript writer; mounted over in compose so runs outlive
# the container.
RUN mkdir -p /runs

# Dropping to the image's existing non-root user: nothing here needs root, and
# the mounted runs directory is the only thing written.
RUN chown -R node:node /app /runs
USER node

EXPOSE 4100
CMD ["node", "server.mjs"]
