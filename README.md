# AI Generated Business Plan Application

## Project Plan

Here is the plan to create the AI-generated business plan application:

1.  **Define core functionality for the AI business plan application.**
2.  **Choose appropriate technologies (frontend, backend, AI model).**
3.  **Set up the project structure and initial files.**
4.  **Implement the user interface for input and displaying generated plans.**
5.  **Develop backend API for handling requests and interacting with the AI model.**
6.  **Integrate an AI model for generating business plans.**
7.  **Implement data storage for user information and generated business plans.**
8.  **Add user authentication and authorization (if necessary).**
9.  **Plan and implement deployment of the application.**
10. **Develop and execute tests for the application.**

## Speech-to-Text Application

This application provides a web interface for transcribing audio to text using Google Cloud Speech-to-Text API.

### Local Setup and Running

To run this application locally, follow these steps:

1.  **Clone the repository (if you haven't already):**
    ```bash
    git clone <your-repository-url>
    cd ai
    ```

2.  **Create a virtual environment (recommended):**
    ```bash
    python -m venv venv
    ```

3.  **Activate the virtual environment:**
    *   **Windows (PowerShell):**
        ```bash
        .\venv\Scripts\Activate.ps1
        ```
    *   **Linux/macOS:**
        ```bash
        source venv/bin/activate
        ```

4.  **Install dependencies:**
    ```bash
    pip install -r requirements.txt
    ```

5.  **Set up Google Cloud Service Account Credentials:**
    *   Obtain your Google Cloud service account JSON key file.
    *   Save this file (e.g., `service_account_key.json`) in a secure location, preferably outside of your project directory for production, but for local testing, you can place it in your project root. **Remember to add `service_account_key.json` to your `.gitignore` file to prevent accidental commits.**
    *   Set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable to the path of your JSON key file.
        *   **Windows (PowerShell):**
            ```bash
            $env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\your\service_account_key.json"
            ```
        *   **Linux/macOS:**
            ```bash
            export GOOGLE_APPLICATION_CREDENTIALS="/path/to/your/service_account_key.json"
            ```
        *   **Note:** This environment variable needs to be set in every new terminal session where you run the application.

6.  **Run the FastHTML application:**
    ```bash
    python app.py
    ```

7.  **Access the application:**
    Open your web browser and navigate to `http://localhost:5001`.

### Running with Docker

To run the application using Docker, which is recommended for deployment and consistent environments:

1.  **Build the Docker image:**
    Navigate to your project root (where `Dockerfile` is located) and run:
    ```bash
    docker build -t speech-to-text-app .
    ```

2.  **Run the Docker container (Secure Credential Handling - Volume Mounting):**
    This method securely injects your service account key into the container at runtime without baking it into the image.

    *   **Save your JSON key:** Ensure your `service_account_key.json` file is saved in a secure location on your host machine (e.g., `C:\Users\YourUser\keys\service_account_key.json` on Windows, or `/home/youruser/keys/service_account_key.json` on Linux/macOS). **Do not commit this file to your GitHub repository!**

    *   **Run the container:**
        ```bash
        docker run -d \
          -p 8000:8000 \
          -v /path/on/host/to/service_account_key.json:/app/service_account_key.json \
          -e GOOGLE_APPLICATION_CREDENTIALS=/app/service_account_key.json \
          speech-to-text-app
        ```
        *   Replace `/path/on/host/to/service_account_key.json` with the actual absolute path to your `service_account_key.json` file on your host machine.
        *   For Windows paths in PowerShell, use:
            ```powershell
            docker run -d `
              -p 8000:8000 `
              -v "C:\Users\YourUser\keys\service_account_key.json":/app/service_account_key.json `
              -e GOOGLE_APPLICATION_CREDENTIALS=/app/service_account_key.json `
              speech-to-text-app
            ```

### Deployment on Railway (Secure Credential Handling)

When deploying to Railway, you can securely inject your Google Cloud service account JSON key using Railway's environment variables and build commands. This prevents the key from being committed to your repository or baked into your Docker image.

1.  **Create a Railway Environment Variable for the JSON content:**
    *   In your Railway project settings, go to the "Variables" tab.
    *   Add a new variable, for example, named `GOOGLE_APPLICATION_CREDENTIALS_JSON`.
    *   For its value, **paste the entire content of your `service_account_key.json` file as a single string.** Ensure there are no extra spaces or newlines.

2.  **Configure Railway Build Command to create the JSON file:**
    *   In your Railway project settings, go to the "Build" tab.
    *   Modify your build command (or add a pre-build command) to write the content of `GOOGLE_APPLICATION_CREDENTIALS_JSON` to a file within your container's `/app` directory. For example:
        ```bash
        echo $GOOGLE_APPLICATION_CREDENTIALS_JSON > /app/service_account_key.json
        ```
        *   Ensure this command runs *before* your application starts and attempts to use the credentials.

3.  **Set `GOOGLE_APPLICATION_CREDENTIALS` environment variable in Railway:**
    *   In your Railway project settings, under the "Variables" tab, add another environment variable named `GOOGLE_APPLICATION_CREDENTIALS`.
    *   Set its value to the path where you created the JSON file in the previous step: `/app/service_account_key.json`.

### Original Certificate Verification Issue (CERTIFICATE_VERIFY_FAILED)

Initially, this project encountered a `CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate` error when attempting to connect to Google Cloud APIs directly from the local Python environment. This issue is often related to:

*   **Corporate Proxies/Firewalls:** SSL inspection proxies can intercept and re-sign SSL certificates, requiring the client system to trust the proxy's certificate.
*   **Outdated CA Certificates:** The local environment's trusted Certificate Authority (CA) bundles might be outdated.
*   **System Trust Store Issues:** Problems with the operating system's root certificate store.

While attempts were made to update `certifi` and set the `REQUESTS_CA_BUNDLE` environment variable, these did not resolve the issue. The decision was made to shift to a web-based application using `python-fasthtml` and Docker for deployment. In deployed environments (especially cloud platforms), SSL certificate handling is typically managed by load balancers or the platform itself, often circumventing these local certificate issues.