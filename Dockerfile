# Use a Python base image
FROM python:3.10-slim-buster

# Set the working directory
WORKDIR /app

# Copy your requirements file and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy your application code
COPY app.py .

# Create a directory for credentials and write the JSON content from an environment variable
RUN mkdir -p /app/gcp-credentials

# Expose the port your FastHTML app runs on
EXPOSE 5001

# Command to run your application
# The GOOGLE_APPLICATION_CREDENTIALS environment variable will be set when you run the container
CMD ["python", "app.py"]
