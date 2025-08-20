# Use a Python base image
FROM python:3.10-slim-bullseye

# Set the working directory
WORKDIR /app

# Copy your requirements file and install dependencies
COPY requirements.txt .
# Install CA certificates to fix TLS verification for Google APIs
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && update-ca-certificates

RUN pip install --no-cache-dir -r requirements.txt

# Copy the entire application code (includes server/, utils/, static/, etc.)
COPY . .

# Create a directory for credentials and write the JSON content from an environment variable
RUN mkdir -p /app/gcp-credentials

# No EXPOSE needed; runtime port is provided by the platform (PORT) or via -p locally

# Command to run your application
# The GOOGLE_APPLICATION_CREDENTIALS environment variable will be set when you run the container
# Ensure OpenSSL finds the system certs
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

CMD ["python", "app.py"]
