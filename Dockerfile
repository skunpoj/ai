# Use a Python base image
FROM python:3.10-slim-buster

# Set the working directory
WORKDIR /app

# Copy your requirements file and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy your application code
COPY app.py .
COPY static ./static

# Create a directory for credentials and write the JSON content from an environment variable
RUN mkdir -p /app/gcp-credentials

# No EXPOSE needed; runtime port is provided by the platform (PORT) or via -p locally

# Command to run your application
# The GOOGLE_APPLICATION_CREDENTIALS environment variable will be set when you run the container
CMD ["python", "app.py"]
