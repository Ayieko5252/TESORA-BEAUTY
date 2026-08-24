# Tessora Beauty shop container.
# The shop has no dependencies to install, so this is deliberately tiny.
FROM node:20-alpine

WORKDIR /app
COPY . .

# Products, orders and uploaded photos are written here.
# Mount your persistent volume at /data so they survive restarts and deploys.
ENV TESSORA_DATA_DIR=/data
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Seeds the sample products the very first time only, then starts the shop.
CMD ["npm", "run", "start:prod"]
