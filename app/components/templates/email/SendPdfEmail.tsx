// React-email
import {
    Html,
    Body,
    Head,
    Heading,
    Hr,
    Container,
    Preview,
    Section,
    Text,
} from "@react-email/components";
import { Tailwind } from "@react-email/tailwind";

type SendPdfEmailProps = {
    invoiceNumber: string;
};

export default function SendPdfEmail({ invoiceNumber }: SendPdfEmailProps) {
    return (
        <Html>
            <Head />
            <Preview>
                Your invoice #{invoiceNumber} is ready for download
            </Preview>
            <Tailwind>
                <Body className="bg-gray-100">
                    <Container>
                        <Section className="bg-white border-black-950 my-10 px-10 py-4 rounded-md">
                            {/* A text wordmark: it renders everywhere, and needs no hosted image. */}
                            <Text className="m-0 text-3xl font-bold" style={{ color: "#4F46E5" }}>
                                BillEase
                            </Text>
                            <Heading className="leading-tight">
                                Thanks for using BillEase!
                            </Heading>

                            <Text>
                                We&apos;re pleased to inform you that your
                                invoice{" "}
                                <b>#{invoiceNumber}</b> is ready for download.
                                Please find the attached PDF document.
                            </Text>

                            <Hr />

                            <Text>
                                Best Regards,
                                <br />
                                BillEase Team
                            </Text>
                        </Section>
                    </Container>
                </Body>
            </Tailwind>
        </Html>
    );
}
